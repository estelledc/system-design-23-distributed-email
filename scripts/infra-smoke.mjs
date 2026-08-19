import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import net from 'node:net';
import { join } from 'node:path';
import { createPool, installSchema, MailRepository } from '../src/repository.js';
import { MailService } from '../src/service.js';
import { bucketForAddress } from '../src/model.js';
import { readOracleLedger } from '../src/smtp-oracle.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; crash smoke never falls back to memory');
const apiToken = process.env.MAIL_API_TOKEN ?? 'smoke-synthetic-token-0001';

function submission(sequence, recipient) {
  const suffix = String(sequence).padStart(8, '0');
  return {
    requestKey: `req_${suffix}`,
    messageId: `msg_${suffix}`,
    envelopeFrom: 'sender@origin.invalid',
    headerFrom: 'author@origin.invalid',
    headerTo: [recipient],
    recipients: [recipient],
    subject: `smoke ${suffix}`,
    body: `bounded smoke body ${suffix}`,
  };
}

function childProcess(script, environment, args = []) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...environment },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  child.stdout.on('data', (chunk) => { output.stdout = `${output.stdout}${chunk}`.slice(-16_384); });
  child.stderr.on('data', (chunk) => { output.stderr = `${output.stderr}${chunk}`.slice(-16_384); });
  return { child, output };
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('child process exit timeout'));
    }, timeoutMs);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal });
    });
  });
}

async function waitForFile(path, timeoutMs = 5_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT' && error.name !== 'SyntaxError') throw error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  throw new Error('ready file timeout');
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startApi(extraEnvironment = {}) {
  const port = await freePort();
  const processInfo = childProcess('src/main.js', {
    DATABASE_URL: databaseUrl,
    MAIL_API_TOKEN: apiToken,
    PORT: String(port),
    ...extraEnvironment,
  });
  const started = Date.now();
  while (!processInfo.output.stdout.includes('server_ready')) {
    if (processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) throw new Error('API exited before ready');
    if (Date.now() - started > 5_000) throw new Error('API ready timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return { ...processInfo, port };
}

async function post(port, path, body) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function runWorker({ oraclePort, assignment, crashVariable }) {
  const environment = {
    DATABASE_URL: databaseUrl,
    SMTP_PORT: String(oraclePort),
    SMTP_TIMEOUT_MS: '500',
    MAIL_BUCKET: assignment.bucket,
    MAIL_WORKER_ID: assignment.workerId,
    MAIL_ASSIGNMENT_GENERATION: String(assignment.generation),
    MAIL_LEASE_SECONDS: '0.15',
    MAIL_RETRY_BASE_SECONDS: '0.05',
  };
  if (crashVariable) environment[crashVariable] = '1';
  const processInfo = childProcess('src/main.js', environment, ['worker-once']);
  return { ...processInfo, exit: await waitForExit(processInfo.child) };
}

async function stop(processInfo) {
  if (!processInfo?.child || processInfo.child.exitCode !== null || processInfo.child.signalCode !== null) return;
  processInfo.child.kill('SIGTERM');
  await waitForExit(processInfo.child);
}

await mkdir('.tmp', { recursive: true });
const temporaryDirectory = await mkdtemp(join('.tmp', 'smoke-'));
const ledgerPath = join(temporaryDirectory, 'oracle.jsonl');
const readyPath = join(temporaryDirectory, 'oracle-ready.json');
const oracleProcess = childProcess('scripts/smtp-oracle-process.mjs', {
  ORACLE_LEDGER_PATH: ledgerPath,
  ORACLE_READY_PATH: readyPath,
});
let apiProcess;
const killedProcesses = [];
const pool = createPool(databaseUrl, { max: 16 });

try {
  const { port: oraclePort } = await waitForFile(readyPath);
  await installSchema(pool);
  const repository = new MailRepository(pool, { retryBaseSeconds: 0.05, maxRetryAgeSeconds: 60 });
  const service = new MailService(repository, { smtpPort: oraclePort, smtpTimeoutMs: 500 });

  await repository.reset();
  apiProcess = await startApi({ MAIL_CRASH_AFTER_SUBMIT_COMMIT: '1' });
  let responseLost = false;
  try {
    await post(apiProcess.port, '/v1/messages', submission(100, 'ok@alpha.invalid'));
  } catch {
    responseLost = true;
  }
  const apiCrash = await waitForExit(apiProcess.child);
  assert.equal(apiCrash.signal, 'SIGKILL');
  killedProcesses.push('submission_response_loss');
  apiProcess = await startApi();
  const replayResponse = await post(apiProcess.port, '/v1/messages', submission(100, 'ok@alpha.invalid'));
  const replayBody = await replayResponse.json();
  assert.equal(responseLost, true);
  assert.equal(replayResponse.status, 200);
  assert.equal(replayBody.data.revision, 1);
  await stop(apiProcess);
  apiProcess = null;

  await repository.reset();
  const preparedRecipient = 'one@alpha.invalid';
  await service.submit(submission(101, preparedRecipient));
  const preparedAssignment = await service.assign({ bucket: bucketForAddress(preparedRecipient), workerId: 'wrk_prepare01' });
  const ledgerBeforePrepared = (await readOracleLedger(ledgerPath)).length;
  const preparedWorker = await runWorker({
    oraclePort,
    assignment: preparedAssignment,
    crashVariable: 'MAIL_CRASH_AFTER_ATTEMPT_PREPARE_COMMIT',
  });
  assert.equal(preparedWorker.exit.signal, 'SIGKILL');
  killedProcesses.push('prepared_before_io');
  assert.equal((await readOracleLedger(ledgerPath)).length, ledgerBeforePrepared);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const preparedRecovery = await service.recover({ ...preparedAssignment, limit: 8 });
  assert.equal(preparedRecovery.recoveredBeforeIo, 1);

  await repository.reset();
  const acceptedRecipient = 'ok@beta.invalid';
  await service.submit(submission(102, acceptedRecipient));
  const acceptedAssignment = await service.assign({ bucket: bucketForAddress(acceptedRecipient), workerId: 'wrk_remote001' });
  const ledgerBeforeAccepted = (await readOracleLedger(ledgerPath)).length;
  const acceptedWorker = await runWorker({
    oraclePort,
    assignment: acceptedAssignment,
    crashVariable: 'MAIL_CRASH_AFTER_REMOTE_REPLY',
  });
  assert.equal(acceptedWorker.exit.signal, 'SIGKILL');
  killedProcesses.push('remote_reply_before_local_commit');
  const afterAcceptedLedger = await readOracleLedger(ledgerPath);
  assert.equal(afterAcceptedLedger.length, ledgerBeforeAccepted + 1);
  assert.equal(afterAcceptedLedger.at(-1).acceptedResponsibility, true);
  await new Promise((resolve) => setTimeout(resolve, 250));
  const acceptedRecovery = await service.recover({ ...acceptedAssignment, limit: 8 });
  assert.equal(acceptedRecovery.uncertainAfterIo, 1);
  const acceptedLive = await service.getMessage('msg_00000102');
  assert.equal(acceptedLive.remoteAcceptedRecipients, 0);
  assert.equal(acceptedLive.state, 'uncertain');

  await repository.reset();
  const transientRecipient = 'temp@gamma.invalid';
  await service.submit(submission(103, transientRecipient));
  const transientAssignment = await service.assign({ bucket: bucketForAddress(transientRecipient), workerId: 'wrk_retry0001' });
  const transientWorker = await runWorker({
    oraclePort,
    assignment: transientAssignment,
    crashVariable: 'MAIL_CRASH_AFTER_COMPLETION_COMMIT',
  });
  assert.equal(transientWorker.exit.signal, 'SIGKILL');
  killedProcesses.push('retry_completion_response_loss');
  const transientLive = await service.getMessage('msg_00000103');
  assert.equal(transientLive.recipients[0].state, 'retry_scheduled');
  assert.equal(transientLive.attempts.length, 1);
  assert.equal(transientLive.attempts[0].state, 'transient_failure');

  await repository.reset();
  const staleRecipient = 'ok@delta.invalid';
  await service.submit(submission(104, staleRecipient));
  const staleAssignment = await service.assign({ bucket: bucketForAddress(staleRecipient), workerId: 'wrk_stale0001' });
  await service.assign({ bucket: staleAssignment.bucket, workerId: 'wrk_current001' });
  const ledgerBeforeStale = (await readOracleLedger(ledgerPath)).length;
  const staleWorker = await runWorker({ oraclePort, assignment: staleAssignment });
  assert.equal(staleWorker.exit.code, 1);
  assert.equal((await readOracleLedger(ledgerPath)).length, ledgerBeforeStale);

  const state = await service.state();
  assert.equal(state.invariantGap, 0);
  assert.equal(killedProcesses.length, 4);
  process.stdout.write(`${JSON.stringify({
    evidence: 'true_process_crash_smoke',
    killedProcesses,
    submission: { responseLost, replayRevision: replayBody.data.revision },
    preparedBeforeIo: { oracleTransactionsAdded: 0, recovered: preparedRecovery.recoveredBeforeIo },
    finalReplyLoss: {
      oracleAccepted: 1,
      localRemoteAcceptedRecipients: acceptedLive.remoteAcceptedRecipients,
      uncertainAfterIo: acceptedRecovery.uncertainAfterIo,
    },
    retryCompletion: { attempts: transientLive.attempts.length, state: transientLive.recipients[0].state },
    staleGenerationRejectedBeforeTcp: true,
    invariantGap: state.invariantGap,
    mailboxDeliveryProved: false,
    inboxPlacementProved: false,
    readProved: false,
    externalAcceptanceProved: false,
  })}\n`);
} finally {
  await stop(apiProcess);
  await pool.end();
  await stop(oracleProcess);
  await rm(temporaryDirectory, { recursive: true, force: true });
}
