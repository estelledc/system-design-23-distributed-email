import { performance } from 'node:perf_hooks';
import { createPool, installSchema, MailRepository } from '../src/repository.js';
import { MailService } from '../src/service.js';
import { bucketNames } from '../src/contracts.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required; benchmark never falls back to memory');

function quantile(values, percentile) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * percentile));
  return Number(sorted[index].toFixed(3));
}

function submission(index) {
  const suffix = String(index).padStart(8, '0');
  const recipients = Array.from({ length: 4 }, (_, ordinal) => `user${suffix}${ordinal}@domain${ordinal}.invalid`);
  return {
    requestKey: `req_${suffix}`,
    messageId: `msg_${suffix}`,
    envelopeFrom: 'sender@origin.invalid',
    headerFrom: 'author@origin.invalid',
    headerTo: recipients,
    recipients,
    subject: `benchmark ${suffix}`,
    body: `fixed synthetic benchmark body ${suffix}`,
  };
}

const smtpAccepted = {
  lastStage: 'final',
  dataBytesSent: true,
  uncertain: false,
  networkFailure: false,
  greetingCode: 220,
  ehloCode: 250,
  mailCode: 250,
  rcptCode: 250,
  dataCode: 354,
  finalCode: 250,
  enhancedStatus: '2.0.0',
};

const pool = createPool(databaseUrl, { max: 16 });
try {
  await installSchema(pool);
  const repository = new MailRepository(pool, { retryBaseSeconds: 0, maxRetryAgeSeconds: 60 });
  const service = new MailService(repository);
  await repository.reset();
  const fixture = {
    seed: 'distributed-email-benchmark-v1',
    messages: 64,
    recipientsPerMessage: 4,
    recipientAttempts: 256,
    destinationBuckets: 4,
    statusSnapshots: 32,
  };

  const submitLatencyMs = [];
  const submitStarted = performance.now();
  for (let start = 0; start < fixture.messages; start += 8) {
    await Promise.all(Array.from({ length: Math.min(8, fixture.messages - start) }, async (_, offset) => {
      const before = performance.now();
      await service.submit(submission(start + offset));
      submitLatencyMs.push(performance.now() - before);
    }));
  }
  const submitWallMs = performance.now() - submitStarted;

  const assignments = new Map();
  for (const [index, bucket] of bucketNames().entries()) {
    assignments.set(bucket, await service.assign({ bucket, workerId: `wrk_benchmark${index}` }));
  }
  const attemptLatencyMs = [];
  let completed = 0;
  const attemptStarted = performance.now();
  while (completed < fixture.recipientAttempts) {
    let progressed = false;
    for (const assignment of assignments.values()) {
      const claimResult = await service.claim({ ...assignment, leaseSeconds: 5 });
      if (!claimResult.claim) continue;
      progressed = true;
      const before = performance.now();
      const claim = claimResult.claim;
      const attempt = await service.prepare({
        messageId: claim.messageId,
        recipientOrdinal: claim.ordinal,
        workerId: assignment.workerId,
        generation: assignment.generation,
        leaseGeneration: claim.leaseGeneration,
      });
      await service.ioStarted({
        attemptId: attempt.attemptId,
        workerId: assignment.workerId,
        generation: assignment.generation,
        leaseGeneration: claim.leaseGeneration,
      });
      await service.complete({
        attemptId: attempt.attemptId,
        workerId: assignment.workerId,
        generation: assignment.generation,
        leaseGeneration: claim.leaseGeneration,
        smtpResult: smtpAccepted,
      });
      attemptLatencyMs.push(performance.now() - before);
      completed += 1;
    }
    if (!progressed) throw new Error('benchmark queue stopped making progress');
  }
  const attemptWallMs = performance.now() - attemptStarted;

  const snapshotLatencyMs = [];
  for (let index = 0; index < fixture.statusSnapshots; index += 1) {
    const suffix = String(index).padStart(8, '0');
    const before = performance.now();
    await service.createStatusQuery({ queryId: `qry_${suffix}`, messageId: `msg_${suffix}` });
    snapshotLatencyMs.push(performance.now() - before);
  }
  const version = (await pool.query('SHOW server_version')).rows[0].server_version;
  const state = await service.state();
  process.stdout.write(`${JSON.stringify({
    evidence: 'bounded_postgresql_benchmark',
    fixture,
    runtime: { node: process.version, postgresql: version },
    observations: {
      submitWallMs: Number(submitWallMs.toFixed(3)),
      submitMessagesPerSecond: Number((fixture.messages / (submitWallMs / 1000)).toFixed(3)),
      submitP50Ms: quantile(submitLatencyMs, 0.5),
      submitP95Ms: quantile(submitLatencyMs, 0.95),
      attemptWallMs: Number(attemptWallMs.toFixed(3)),
      attemptsPerSecond: Number((completed / (attemptWallMs / 1000)).toFixed(3)),
      attemptP50Ms: quantile(attemptLatencyMs, 0.5),
      attemptP95Ms: quantile(attemptLatencyMs, 0.95),
      snapshotP50Ms: quantile(snapshotLatencyMs, 0.5),
      snapshotP95Ms: quantile(snapshotLatencyMs, 0.95),
    },
    counts: { completed, remoteAccepted: state.states.remote_accepted ?? 0, invariantGap: state.invariantGap },
    exclusions: [
      'public SMTP', 'DNS/MX', 'TLS', 'MIME/attachments', 'mailbox/inbox/read', 'replication/failover',
      'production contention', 'deliverability', 'SLA', 'external acceptance',
    ],
  })}\n`);
} finally {
  await pool.end();
}
