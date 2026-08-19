import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import { createPool, installSchema, MailRepository } from '../../src/repository.js';
import { MailService } from '../../src/service.js';
import { createSmtpOracle, readOracleLedger } from '../../src/smtp-oracle.js';
import { bucketForAddress } from '../../src/model.js';
import { parseSubmission } from '../../src/contracts.js';
import { sendSmtpMessage } from '../../src/smtp-client.js';

// Infrastructure tests never skip: missing PostgreSQL is a failed evidence gate.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; infrastructure tests never skip');

let pool;
let repository;
let service;
let oracle;
let temporaryDirectory;
let ledgerPath;

function submission(sequence, recipient = 'ok@alpha.invalid', overrides = {}) {
  const suffix = String(sequence).padStart(8, '0');
  return {
    requestKey: `req_${suffix}`,
    messageId: `msg_${suffix}`,
    envelopeFrom: 'sender@origin.invalid',
    headerFrom: 'author@origin.invalid',
    headerTo: [recipient],
    recipients: [recipient],
    subject: `synthetic ${suffix}`,
    body: `bounded body ${suffix}`,
    ...overrides,
  };
}

async function assignmentFor(recipient, workerId = 'wrk_example0001') {
  return service.assign({ bucket: bucketForAddress(recipient), workerId });
}

async function waitForExpiry(milliseconds = 250) {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function closedLoopbackPort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function recipientsInDistinctBuckets() {
  const recipients = [];
  const used = new Set();
  for (const mode of ['ok', 'temp', 'reject', 'drop']) {
    for (let index = 0; index < 100; index += 1) {
      const candidate = `${mode}@${mode}${index}.invalid`;
      const bucket = bucketForAddress(candidate);
      if (!used.has(bucket)) {
        used.add(bucket);
        recipients.push(candidate);
        break;
      }
    }
  }
  assert.equal(recipients.length, 4);
  return recipients;
}

before(async () => {
  await mkdir('.tmp', { recursive: true });
  temporaryDirectory = await mkdtemp(join('.tmp', 'integration-'));
  ledgerPath = join(temporaryDirectory, 'oracle.jsonl');
  oracle = await createSmtpOracle({ ledgerPath });
  pool = createPool(databaseUrl, { max: 20 });
  await installSchema(pool);
  repository = new MailRepository(pool, { retryBaseSeconds: 0, maxRetryAgeSeconds: 60 });
  service = new MailService(repository, { smtpPort: oracle.port, smtpTimeoutMs: 500 });
});

beforeEach(async () => {
  await repository.reset();
  await rm(ledgerPath, { force: true });
});

after(async () => {
  await oracle?.close();
  await pool?.end();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test('submission atomically fans out, replays exact intent, conflicts on change, and rolls back partial work', async () => {
  const input = submission(1, 'one@alpha.invalid', {
    headerTo: ['one@alpha.invalid', 'two@beta.invalid'],
    recipients: ['one@alpha.invalid', 'two@beta.invalid'],
  });
  const concurrent = await Promise.all(Array.from({ length: 8 }, () => service.submit(input)));
  assert.equal(concurrent.filter((entry) => entry.created).length, 1);
  assert.ok(concurrent.every((entry) => entry.result.revision === 1 && entry.result.recipientCount === 2));
  await assert.rejects(() => service.submit({ ...input, body: 'changed body' }), (error) => error.code === 'intent_conflict');

  const parsed = (await import('../../src/contracts.js')).parseSubmission(submission(2, 'three@alpha.invalid'));
  parsed.recipients = ['same@alpha.invalid', 'same@alpha.invalid'];
  await assert.rejects(() => repository.submitMessage('tenant_lab', parsed));
  const count = await pool.query("SELECT COUNT(*)::int AS count FROM messages WHERE message_id = 'msg_00000002'");
  assert.equal(count.rows[0].count, 0);
});

test('assignment takeover fences stale preparation and current generation recovers an expired lease', async () => {
  const recipient = 'one@alpha.invalid';
  await service.submit(submission(3, recipient));
  const first = await assignmentFor(recipient, 'wrk_first0001');
  const claim = (await service.claim({ ...first, leaseSeconds: 0.15 })).claim;
  const second = await assignmentFor(recipient, 'wrk_second001');
  await assert.rejects(() => service.prepare({
    messageId: claim.messageId,
    recipientOrdinal: claim.ordinal,
    workerId: first.workerId,
    generation: first.generation,
    leaseGeneration: claim.leaseGeneration,
  }), (error) => error.code === 'stale_generation');
  await waitForExpiry();
  const recovered = await service.recover({ ...second, limit: 8 });
  assert.equal(recovered.releasedLeases, 1);
  const claimedAgain = (await service.claim({ ...second, leaseSeconds: 1 })).claim;
  assert.equal(claimedAgain.messageId, claim.messageId);
  assert.equal(claimedAgain.leaseGeneration, claim.leaseGeneration + 1);
});

test('prepared-only crash recovery is safe while io-started expiry becomes uncertainty', async () => {
  const beforeIoRecipient = 'one@alpha.invalid';
  await service.submit(submission(4, beforeIoRecipient));
  const worker = await assignmentFor(beforeIoRecipient);
  const claim = (await service.claim({ ...worker, leaseSeconds: 0.15 })).claim;
  await service.prepare({
    messageId: claim.messageId, recipientOrdinal: claim.ordinal, workerId: worker.workerId,
    generation: worker.generation, leaseGeneration: claim.leaseGeneration,
  });
  await waitForExpiry();
  const preparedAttempt = (await service.getMessage(claim.messageId)).attempts[0];
  await assert.rejects(() => service.ioStarted({
    attemptId: preparedAttempt.attemptId,
    workerId: worker.workerId,
    generation: worker.generation,
    leaseGeneration: claim.leaseGeneration,
  }), (error) => error.code === 'stale_generation');
  assert.equal((await service.recover({ ...worker, limit: 8 })).recoveredBeforeIo, 1);
  assert.equal((await service.getMessage(claim.messageId)).recipients[0].state, 'retry_scheduled');
  assert.equal((await readOracleLedger(ledgerPath)).length, 0);

  await repository.reset();
  await service.submit(submission(5, beforeIoRecipient));
  const nextWorker = await assignmentFor(beforeIoRecipient);
  const nextClaim = (await service.claim({ ...nextWorker, leaseSeconds: 0.15 })).claim;
  const attempt = await service.prepare({
    messageId: nextClaim.messageId, recipientOrdinal: nextClaim.ordinal, workerId: nextWorker.workerId,
    generation: nextWorker.generation, leaseGeneration: nextClaim.leaseGeneration,
  });
  await service.ioStarted({
    attemptId: attempt.attemptId, workerId: nextWorker.workerId, generation: nextWorker.generation,
    leaseGeneration: nextClaim.leaseGeneration,
  });
  await waitForExpiry();
  await assert.rejects(() => service.complete({
    attemptId: attempt.attemptId,
    workerId: nextWorker.workerId,
    generation: nextWorker.generation,
    leaseGeneration: nextClaim.leaseGeneration,
    smtpResult: {
      lastStage: 'final', dataBytesSent: true, uncertain: false, networkFailure: false,
      greetingCode: 220, ehloCode: 250, mailCode: 250, rcptCode: 250, dataCode: 354,
      finalCode: 250, enhancedStatus: '2.0.0',
    },
  }), (error) => error.code === 'stale_generation');
  assert.equal((await service.recover({ ...nextWorker, limit: 8 })).uncertainAfterIo, 1);
  const live = await service.getMessage(nextClaim.messageId);
  assert.equal(live.state, 'uncertain');
  assert.equal(live.remoteAcceptedRecipients, 0);
});

test('real loopback SMTP keeps 250, 451, 550, and accepted-without-reply outcomes distinct', async () => {
  const scenarios = [
    ['ok@alpha.invalid', 'remote_accepted'],
    ['temp@alpha.invalid', 'retry_scheduled'],
    ['reject@alpha.invalid', 'permanent_rejected'],
    ['drop@alpha.invalid', 'unknown_after_io'],
  ];
  for (const [index, [recipient, expected]] of scenarios.entries()) {
    await repository.reset();
    await rm(ledgerPath, { force: true });
    await service.submit(submission(10 + index, recipient));
    const worker = await assignmentFor(recipient);
    const delivered = await service.deliverOne({ ...worker, leaseSeconds: 1 });
    assert.equal(delivered.completion.state, expected);
    assert.equal(delivered.completion.mailboxDelivered, false);
    const ledger = await readOracleLedger(ledgerPath);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].acceptedResponsibility, expected === 'remote_accepted' || expected === 'unknown_after_io');
    if (expected === 'remote_accepted') {
      const live = await service.getMessage(`msg_${String(10 + index).padStart(8, '0')}`);
      const recordedAttempt = live.attempts[0];
      const exactResult = {
        lastStage: 'final', dataBytesSent: true, uncertain: false, networkFailure: false,
        greetingCode: 220, ehloCode: 250, mailCode: 250, rcptCode: 250, dataCode: 354,
        finalCode: 250, enhancedStatus: '2.0.0',
      };
      assert.equal((await service.complete({
        attemptId: recordedAttempt.attemptId,
        workerId: worker.workerId,
        generation: worker.generation,
        leaseGeneration: recordedAttempt.leaseGeneration,
        smtpResult: exactResult,
      })).state, 'remote_accepted');
      await assert.rejects(() => service.complete({
        attemptId: recordedAttempt.attemptId,
        workerId: worker.workerId,
        generation: worker.generation,
        leaseGeneration: recordedAttempt.leaseGeneration,
        smtpResult: { ...exactResult, finalCode: 251 },
      }), (error) => error.code === 'intent_conflict');
    }
  }
});

test('one message retains four independent recipient outcomes and a real connect refusal is retryable only before bytes', async () => {
  const recipients = recipientsInDistinctBuckets();
  await service.submit(submission(18, recipients[0], { headerTo: recipients, recipients }));
  for (const [index, recipient] of recipients.entries()) {
    const worker = await assignmentFor(recipient, `wrk_mixed000${index}`);
    await service.deliverOne({ ...worker, leaseSeconds: 1 });
  }
  const live = await service.getMessage('msg_00000018');
  assert.deepEqual(live.recipients.map((entry) => entry.state).sort(), [
    'permanent_rejected', 'remote_accepted', 'retry_scheduled', 'unknown_after_io',
  ]);
  assert.equal(live.state, 'uncertain');
  assert.equal(live.remoteAcceptedRecipients, 1);
  assert.equal(live.mailboxDeliveredRecipients, 0);

  const parsed = parseSubmission(submission(19, 'ok@alpha.invalid'));
  const refused = await sendSmtpMessage({
    port: await closedLoopbackPort(),
    envelopeFrom: parsed.envelopeFrom,
    envelopeTo: parsed.recipients[0],
    canonicalContent: parsed.canonicalContent,
    timeoutMs: 250,
  });
  assert.equal(refused.networkFailure, true);
  assert.equal(refused.dataBytesSent, false);
  assert.equal(refused.uncertain, false);
});

test('suppression wins before TCP and immutable snapshot pages do not mix with later attempts', async () => {
  const recipient = 'one@alpha.invalid';
  await service.suppress({ address: recipient, active: true });
  await service.submit(submission(20, recipient));
  const worker = await assignmentFor(recipient);
  const suppressed = await service.claim({ ...worker, leaseSeconds: 1 });
  assert.equal(suppressed.claim, null);
  assert.equal(suppressed.suppressedCount, 1);
  assert.equal((await readOracleLedger(ledgerPath)).length, 0);

  await repository.reset();
  const lateRecipient = 'late@alpha.invalid';
  await service.submit(submission(22, lateRecipient));
  const lateWorker = await assignmentFor(lateRecipient);
  const lateClaim = (await service.claim({ ...lateWorker, leaseSeconds: 1 })).claim;
  await service.suppress({ address: lateRecipient, active: true });
  const latePrepare = await service.prepare({
    messageId: lateClaim.messageId,
    recipientOrdinal: lateClaim.ordinal,
    workerId: lateWorker.workerId,
    generation: lateWorker.generation,
    leaseGeneration: lateClaim.leaseGeneration,
  });
  assert.equal(latePrepare.state, 'suppressed');
  assert.equal((await readOracleLedger(ledgerPath)).length, 0);

  await repository.reset();
  await service.submit(submission(21, 'ok@alpha.invalid'));
  const snapshot = await service.createStatusQuery({ queryId: 'qry_snapshot0001', messageId: 'msg_00000021' });
  const deliveryWorker = await assignmentFor('ok@alpha.invalid');
  await service.deliverOne({ ...deliveryWorker, leaseSeconds: 1 });
  const oldPage = await service.getStatusPage('qry_snapshot0001', 0, 2);
  const live = await service.getMessage('msg_00000021');
  assert.equal(oldPage.recipients[0].state, 'queued');
  assert.equal(live.recipients[0].state, 'remote_accepted');
});

test('transient attempts terminate at the finite budget without becoming remote acceptance', async () => {
  const recipient = 'temp@alpha.invalid';
  await service.submit(submission(30, recipient));
  const worker = await assignmentFor(recipient);
  let last;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    last = await service.deliverOne({ ...worker, leaseSeconds: 1 });
    assert.equal(last.completion.attemptNumber, attempt);
  }
  assert.equal(last.completion.state, 'dead_lettered');
  const live = await service.getMessage('msg_00000030');
  assert.equal(live.recipients[0].attemptCount, 3);
  assert.equal(live.attempts.length, 3);
  const state = await service.state();
  assert.equal(state.invariantGap, 0);
  assert.equal(state.externalAcceptanceProved, false);
});
