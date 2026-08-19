import { readFile } from 'node:fs/promises';
import pg from 'pg';
import { digestObject } from './crypto.js';
import { conflict, notFound } from './errors.js';
import {
  addressDigest,
  backoffSeconds,
  bucketForAddress,
  classifySmtpResult,
  MAX_ATTEMPTS,
  projectMessageState,
  publicEvidenceFields,
} from './model.js';

const { Pool } = pg;
const TERMINAL_ATTEMPTS = new Set([
  'remote_accepted', 'transient_failure', 'permanent_failure', 'network_failure', 'abandoned_before_io', 'unknown_after_io',
]);

function number(value) {
  return typeof value === 'number' ? value : Number(value);
}

function iso(value) {
  return value === null || value === undefined ? null : new Date(value).toISOString();
}

function publicRecipient(row) {
  return {
    ordinal: number(row.recipient_ordinal),
    addressDigest: row.address_digest,
    bucket: row.domain_bucket,
    state: row.state,
    revision: number(row.revision),
    attemptCount: number(row.attempt_count),
    nextAttemptAt: iso(row.next_attempt_at),
    leaseGeneration: number(row.lease_generation),
  };
}

function publicAttempt(row) {
  return {
    attemptId: row.attempt_id,
    recipientOrdinal: number(row.recipient_ordinal),
    attemptNumber: number(row.attempt_number),
    assignmentGeneration: number(row.assignment_generation),
    leaseGeneration: number(row.lease_generation),
    state: row.state,
    lastStage: row.last_stage,
    greetingCode: row.greeting_code,
    ehloCode: row.ehlo_code,
    mailCode: row.mail_code,
    rcptCode: row.rcpt_code,
    dataCode: row.data_code,
    finalCode: row.final_code,
    enhancedStatus: row.enhanced_status,
  };
}

async function advisoryLock(client, keys) {
  for (const key of [...keys].sort()) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
  }
}

export function createPool(connectionString = process.env.DATABASE_URL, options = {}) {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({ connectionString, max: options.max ?? 12, idleTimeoutMillis: 5_000 });
}

export async function installSchema(pool) {
  const sql = await readFile(new URL('../sql/schema.sql', import.meta.url), 'utf8');
  await pool.query(sql);
}

export class MailRepository {
  constructor(pool, { retryBaseSeconds = 1800, maxRetryAgeSeconds = 5 * 24 * 60 * 60 } = {}) {
    this.pool = pool;
    this.retryBaseSeconds = retryBaseSeconds;
    this.maxRetryAgeSeconds = maxRetryAgeSeconds;
  }

  async transaction(work, isolation = null) {
    const client = await this.pool.connect();
    try {
      await client.query(isolation ? `BEGIN ISOLATION LEVEL ${isolation}` : 'BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async submitMessage(principal, input) {
    return this.transaction(async (client) => {
      await advisoryLock(client, [
        `message:${principal}:${input.messageId}`,
        `request:${principal}:${input.requestKey}:submit_message`,
      ]);

      const priorReceipt = await client.query(
        `SELECT intent_digest, result FROM mutation_receipts
         WHERE principal = $1 AND request_key = $2 AND operation = 'submit_message'`,
        [principal, input.requestKey],
      );
      if (priorReceipt.rowCount === 1) {
        if (priorReceipt.rows[0].intent_digest !== input.intentDigest) throw conflict('request key was already used for changed intent');
        return { created: false, result: priorReceipt.rows[0].result };
      }

      let message = (await client.query(
        'SELECT * FROM messages WHERE principal = $1 AND message_id = $2 FOR UPDATE',
        [principal, input.messageId],
      )).rows[0];
      if (message && message.intent_digest !== input.intentDigest) throw conflict('message identity was already used for changed intent');

      let created = false;
      if (!message) {
        created = true;
        message = (await client.query(
          `INSERT INTO messages (
             principal, message_id, intent_digest, content_digest, envelope_from, header_from, header_to,
             subject, canonical_content, content_bytes, recipient_count
           ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11)
           RETURNING *`,
          [
            principal, input.messageId, input.intentDigest, input.contentDigest, input.envelopeFrom, input.headerFrom,
            JSON.stringify(input.headerTo), input.subject, input.canonicalContent, Buffer.byteLength(input.canonicalContent),
            input.recipients.length,
          ],
        )).rows[0];
        for (const [ordinal, recipient] of input.recipients.entries()) {
          await client.query(
            `INSERT INTO recipient_work (
               principal, message_id, recipient_ordinal, envelope_to, address_digest, domain_bucket, state, next_attempt_at
             ) VALUES ($1,$2,$3,$4,$5,$6,'queued',$7)`,
            [principal, input.messageId, ordinal, recipient, addressDigest(recipient), bucketForAddress(recipient), message.accepted_at],
          );
        }
      }

      const result = {
        messageId: input.messageId,
        revision: number(message.revision),
        recipientCount: number(message.recipient_count),
        durableAccepted: true,
        acceptedAt: iso(message.accepted_at),
        ...publicEvidenceFields(0),
      };
      await client.query(
        `INSERT INTO mutation_receipts (principal, request_key, operation, intent_digest, entity_id, result)
         VALUES ($1,$2,'submit_message',$3,$4,$5::jsonb)`,
        [principal, input.requestKey, input.intentDigest, input.messageId, JSON.stringify(result)],
      );
      return { created, result };
    });
  }

  async getMutationReceipt(principal, requestKey) {
    const result = await this.pool.query(
      `SELECT operation, entity_id, result, created_at FROM mutation_receipts
       WHERE principal = $1 AND request_key = $2 ORDER BY operation LIMIT 1`,
      [principal, requestKey],
    );
    if (result.rowCount === 0) throw notFound('mutation receipt not found');
    return { operation: result.rows[0].operation, entityId: result.rows[0].entity_id, result: result.rows[0].result };
  }

  async assignWorker({ bucket, workerId }) {
    return this.transaction(async (client) => {
      const row = (await client.query(
        `INSERT INTO worker_assignments (domain_bucket, generation, worker_id)
         VALUES ($1, 1, $2)
         ON CONFLICT (domain_bucket) DO UPDATE
           SET generation = worker_assignments.generation + 1, worker_id = EXCLUDED.worker_id,
               updated_at = statement_timestamp()
         RETURNING domain_bucket, generation, worker_id`,
        [bucket, workerId],
      )).rows[0];
      return { bucket: row.domain_bucket, generation: number(row.generation), workerId: row.worker_id };
    });
  }

  async assertAssignment(client, bucket, workerId, generation) {
    const row = (await client.query(
      'SELECT * FROM worker_assignments WHERE domain_bucket = $1 FOR UPDATE',
      [bucket],
    )).rows[0];
    if (!row || row.worker_id !== workerId || number(row.generation) !== generation) {
      throw conflict('worker assignment generation is stale', 'stale_generation');
    }
    return row;
  }

  async claimNext(principal, { bucket, workerId, generation, leaseSeconds }) {
    return this.transaction(async (client) => {
      await this.assertAssignment(client, bucket, workerId, generation);
      const suppressed = await client.query(
        `WITH candidate AS (
           SELECT r.principal, r.message_id, r.recipient_ordinal
           FROM recipient_work r
           JOIN suppressions s ON s.principal = r.principal AND s.address_digest = r.address_digest AND s.active
           WHERE r.principal = $1 AND r.domain_bucket = $2
             AND r.state IN ('queued', 'retry_scheduled') AND r.next_attempt_at <= statement_timestamp()
           ORDER BY r.next_attempt_at, r.first_queued_at, r.message_id, r.recipient_ordinal
           FOR UPDATE OF r SKIP LOCKED LIMIT 1
         )
         UPDATE recipient_work r
         SET state = 'suppressed', revision = r.revision + 1, next_attempt_at = NULL,
             updated_at = statement_timestamp()
         FROM candidate c
         WHERE r.principal = c.principal AND r.message_id = c.message_id AND r.recipient_ordinal = c.recipient_ordinal
         RETURNING r.recipient_ordinal`,
        [principal, bucket],
      );

      const claimed = await client.query(
        `WITH candidate AS (
           SELECT principal, message_id, recipient_ordinal, state
           FROM recipient_work
           WHERE principal = $1 AND domain_bucket = $2
             AND state IN ('queued', 'retry_scheduled') AND next_attempt_at <= statement_timestamp()
           ORDER BY next_attempt_at, first_queued_at, message_id, recipient_ordinal
           FOR UPDATE SKIP LOCKED LIMIT 1
         )
         UPDATE recipient_work r
         SET state = 'leased', revision = r.revision + 1, next_attempt_at = NULL,
             leased_from_state = c.state, lease_generation = r.lease_generation + 1,
             lease_owner = $3, lease_assignment_generation = $4,
             lease_deadline = statement_timestamp() + ($5 * interval '1 second'),
             updated_at = statement_timestamp()
         FROM candidate c
         WHERE r.principal = c.principal AND r.message_id = c.message_id AND r.recipient_ordinal = c.recipient_ordinal
         RETURNING r.*`,
        [principal, bucket, workerId, generation, leaseSeconds],
      );
      if (claimed.rowCount === 0) return { claim: null, suppressedCount: suppressed.rowCount };
      const row = claimed.rows[0];
      const message = (await client.query(
        `SELECT envelope_from, canonical_content, content_digest FROM messages
         WHERE principal = $1 AND message_id = $2`,
        [principal, row.message_id],
      )).rows[0];
      return {
        suppressedCount: suppressed.rowCount,
        claim: {
          ...publicRecipient(row),
          messageId: row.message_id,
          leaseDeadline: iso(row.lease_deadline),
          workerId,
          assignmentGeneration: generation,
          envelopeFrom: message.envelope_from,
          envelopeTo: row.envelope_to,
          canonicalContent: message.canonical_content,
          contentDigest: message.content_digest,
        },
      };
    });
  }

  async prepareAttempt(principal, input) {
    return this.transaction(async (client) => {
      const recipient = (await client.query(
        `SELECT r.* FROM recipient_work r
         WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3 FOR UPDATE`,
        [principal, input.messageId, input.recipientOrdinal],
      )).rows[0];
      if (!recipient) throw notFound('recipient work not found');
      await this.assertAssignment(client, recipient.domain_bucket, input.workerId, input.generation);

      if (recipient.state === 'attempting' && recipient.current_attempt_id) {
        const existing = (await client.query('SELECT * FROM attempts WHERE attempt_id = $1', [recipient.current_attempt_id])).rows[0];
        if (existing && existing.worker_id === input.workerId
          && number(existing.assignment_generation) === input.generation
          && number(existing.lease_generation) === input.leaseGeneration) return publicAttempt(existing);
      }
      if (recipient.state !== 'leased' || recipient.lease_owner !== input.workerId
        || number(recipient.lease_assignment_generation) !== input.generation
        || number(recipient.lease_generation) !== input.leaseGeneration) {
        throw conflict('recipient lease is stale', 'stale_generation');
      }
      const clock = (await client.query('SELECT statement_timestamp() AS now')).rows[0].now;
      if (new Date(recipient.lease_deadline) <= new Date(clock)) throw conflict('recipient lease expired', 'stale_generation');
      const suppression = (await client.query(
        `SELECT generation FROM suppressions
         WHERE principal = $1 AND address_digest = $2 AND active`,
        [principal, recipient.address_digest],
      )).rows[0];
      if (suppression) {
        const updated = (await client.query(
          `UPDATE recipient_work SET state = 'suppressed', revision = revision + 1, next_attempt_at = NULL,
             leased_from_state = NULL, lease_owner = NULL, lease_assignment_generation = NULL,
             lease_deadline = NULL, current_attempt_id = NULL, updated_at = $4
           WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3 RETURNING revision`,
          [principal, input.messageId, input.recipientOrdinal, clock],
        )).rows[0];
        return {
          suppressed: true,
          recipientOrdinal: input.recipientOrdinal,
          recipientRevision: number(updated.revision),
          suppressionGeneration: number(suppression.generation),
          state: 'suppressed',
        };
      }
      const attemptNumber = number(recipient.attempt_count) + 1;
      if (attemptNumber > MAX_ATTEMPTS) throw conflict('recipient attempt budget is exhausted', 'invalid_transition');
      const attemptId = `att_${digestObject({ principal, messageId: input.messageId, ordinal: input.recipientOrdinal, attemptNumber }).slice(0, 32)}`;
      const attempt = (await client.query(
        `INSERT INTO attempts (
           attempt_id, principal, message_id, recipient_ordinal, attempt_number, worker_id,
           assignment_generation, lease_generation, state
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared') RETURNING *`,
        [attemptId, principal, input.messageId, input.recipientOrdinal, attemptNumber, input.workerId, input.generation, input.leaseGeneration],
      )).rows[0];
      await client.query(
        `UPDATE recipient_work SET state = 'attempting', revision = revision + 1,
           attempt_count = $4, current_attempt_id = $5, updated_at = statement_timestamp()
         WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3`,
        [principal, input.messageId, input.recipientOrdinal, attemptNumber, attemptId],
      );
      return publicAttempt(attempt);
    });
  }

  async markIoStarted(principal, input) {
    return this.transaction(async (client) => {
      const attempt = (await client.query('SELECT * FROM attempts WHERE attempt_id = $1 FOR UPDATE', [input.attemptId])).rows[0];
      if (!attempt || attempt.principal !== principal) throw notFound('attempt not found');
      if (attempt.state === 'io_started') return publicAttempt(attempt);
      if (attempt.state !== 'prepared') throw conflict('attempt cannot cross the I/O boundary', 'invalid_transition');
      const recipient = (await client.query(
        `SELECT * FROM recipient_work WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3 FOR UPDATE`,
        [principal, attempt.message_id, attempt.recipient_ordinal],
      )).rows[0];
      await this.assertAssignment(client, recipient.domain_bucket, input.workerId, input.generation);
      if (recipient.state !== 'attempting' || recipient.current_attempt_id !== input.attemptId
        || recipient.lease_owner !== input.workerId || number(recipient.lease_generation) !== input.leaseGeneration
        || number(recipient.lease_assignment_generation) !== input.generation) {
        throw conflict('attempt ownership is stale', 'stale_generation');
      }
      const clock = (await client.query('SELECT statement_timestamp() AS now')).rows[0].now;
      if (new Date(recipient.lease_deadline) <= new Date(clock)) throw conflict('attempt lease expired', 'stale_generation');
      const updated = (await client.query(
        `UPDATE attempts SET state = 'io_started', io_started_at = statement_timestamp()
         WHERE attempt_id = $1 RETURNING *`,
        [input.attemptId],
      )).rows[0];
      await client.query(
        `UPDATE recipient_work SET revision = revision + 1, updated_at = statement_timestamp()
         WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3`,
        [principal, attempt.message_id, attempt.recipient_ordinal],
      );
      return publicAttempt(updated);
    });
  }

  async completeAttempt(principal, input) {
    const completionDigest = digestObject(input.smtpResult);
    return this.transaction(async (client) => {
      const attempt = (await client.query('SELECT * FROM attempts WHERE attempt_id = $1 FOR UPDATE', [input.attemptId])).rows[0];
      if (!attempt || attempt.principal !== principal) throw notFound('attempt not found');
      if (TERMINAL_ATTEMPTS.has(attempt.state)) {
        if (attempt.completion_digest !== completionDigest) throw conflict('attempt completion changed after commit');
        return attempt.completion_result;
      }
      if (attempt.state !== 'io_started') throw conflict('attempt has not crossed the I/O boundary', 'invalid_transition');
      const recipient = (await client.query(
        `SELECT r.*, m.accepted_at FROM recipient_work r
         JOIN messages m ON m.principal = r.principal AND m.message_id = r.message_id
         WHERE r.principal = $1 AND r.message_id = $2 AND r.recipient_ordinal = $3 FOR UPDATE OF r`,
        [principal, attempt.message_id, attempt.recipient_ordinal],
      )).rows[0];
      await this.assertAssignment(client, recipient.domain_bucket, input.workerId, input.generation);
      if (recipient.state !== 'attempting' || recipient.current_attempt_id !== input.attemptId
        || recipient.lease_owner !== input.workerId || number(recipient.lease_generation) !== input.leaseGeneration
        || number(recipient.lease_assignment_generation) !== input.generation) {
        throw conflict('attempt completion ownership is stale', 'stale_generation');
      }

      const decision = classifySmtpResult(input.smtpResult);
      const now = new Date((await client.query('SELECT statement_timestamp() AS now')).rows[0].now);
      if (new Date(recipient.lease_deadline) <= now) throw conflict('attempt lease expired', 'stale_generation');
      const retryDelay = backoffSeconds(number(attempt.attempt_number), this.retryBaseSeconds);
      const retryWithinAge = now.getTime() + retryDelay * 1000
        <= new Date(recipient.accepted_at).getTime() + this.maxRetryAgeSeconds * 1000;
      let recipientState;
      let nextAttemptAt = null;
      if (decision.action === 'remote_accepted') recipientState = 'remote_accepted';
      else if (decision.action === 'permanent_rejected') recipientState = 'permanent_rejected';
      else if (decision.action === 'unknown') recipientState = 'unknown_after_io';
      else if (number(attempt.attempt_number) >= MAX_ATTEMPTS || !retryWithinAge) recipientState = 'dead_lettered';
      else {
        recipientState = 'retry_scheduled';
        nextAttemptAt = new Date(now.getTime() + retryDelay * 1000);
      }
      const revision = number(recipient.revision) + 1;
      const result = {
        attemptId: input.attemptId,
        attemptNumber: number(attempt.attempt_number),
        recipientOrdinal: number(attempt.recipient_ordinal),
        recipientRevision: revision,
        state: recipientState,
        nextAttemptAt: iso(nextAttemptAt),
        remoteAccepted: recipientState === 'remote_accepted',
        mailboxDelivered: false,
        inboxPlaced: false,
        read: false,
        externalAcceptanceProved: false,
      };
      await client.query(
        `UPDATE attempts SET state = $2, completed_at = $3, last_stage = $4,
           greeting_code = $5, ehlo_code = $6, mail_code = $7, rcpt_code = $8,
           data_code = $9, final_code = $10, enhanced_status = $11,
           completion_digest = $12, completion_result = $13::jsonb
         WHERE attempt_id = $1`,
        [
          input.attemptId, decision.attemptState, now, input.smtpResult.lastStage, input.smtpResult.greetingCode,
          input.smtpResult.ehloCode, input.smtpResult.mailCode, input.smtpResult.rcptCode, input.smtpResult.dataCode,
          input.smtpResult.finalCode, input.smtpResult.enhancedStatus, completionDigest, JSON.stringify(result),
        ],
      );
      await client.query(
        `UPDATE recipient_work SET state = $4, revision = $5, next_attempt_at = $6,
           leased_from_state = NULL, lease_owner = NULL, lease_assignment_generation = NULL,
           lease_deadline = NULL, current_attempt_id = NULL, updated_at = $7
         WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3`,
        [principal, attempt.message_id, attempt.recipient_ordinal, recipientState, revision, nextAttemptAt, now],
      );
      return result;
    });
  }

  async recoverExpired(principal, { bucket, workerId, generation, limit }) {
    return this.transaction(async (client) => {
      await this.assertAssignment(client, bucket, workerId, generation);
      const now = new Date((await client.query('SELECT statement_timestamp() AS now')).rows[0].now);
      const expired = (await client.query(
        `SELECT * FROM recipient_work
         WHERE principal = $1 AND domain_bucket = $2 AND state IN ('leased', 'attempting')
           AND lease_deadline <= $3
         ORDER BY lease_deadline, message_id, recipient_ordinal
         FOR UPDATE SKIP LOCKED LIMIT $4`,
        [principal, bucket, now, limit],
      )).rows;
      const result = { recoveredBeforeIo: 0, uncertainAfterIo: 0, releasedLeases: 0, deadLettered: 0 };
      for (const recipient of expired) {
        if (recipient.state === 'leased') {
          await client.query(
            `UPDATE recipient_work SET state = $4, revision = revision + 1, next_attempt_at = $5,
               leased_from_state = NULL, lease_owner = NULL, lease_assignment_generation = NULL,
               lease_deadline = NULL, current_attempt_id = NULL, updated_at = $5
             WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3`,
            [principal, recipient.message_id, recipient.recipient_ordinal, recipient.leased_from_state, now],
          );
          result.releasedLeases += 1;
          continue;
        }
        const attempt = (await client.query(
          'SELECT * FROM attempts WHERE attempt_id = $1 FOR UPDATE',
          [recipient.current_attempt_id],
        )).rows[0];
        const beforeIo = attempt?.state === 'prepared';
        const attemptState = beforeIo ? 'abandoned_before_io' : 'unknown_after_io';
        let recipientState = beforeIo ? 'retry_scheduled' : 'unknown_after_io';
        if (beforeIo && number(recipient.attempt_count) >= MAX_ATTEMPTS) recipientState = 'dead_lettered';
        const nextAttemptAt = recipientState === 'retry_scheduled' ? now : null;
        const completion = {
          attemptId: attempt.attempt_id,
          attemptNumber: number(attempt.attempt_number),
          recipientOrdinal: number(recipient.recipient_ordinal),
          recipientRevision: number(recipient.revision) + 1,
          state: recipientState,
          nextAttemptAt: iso(nextAttemptAt),
          remoteAccepted: false,
          mailboxDelivered: false,
          inboxPlaced: false,
          read: false,
          externalAcceptanceProved: false,
          recovery: beforeIo ? 'expired_before_io' : 'expired_after_io_started',
        };
        const completionDigest = digestObject(completion);
        await client.query(
          `UPDATE attempts SET state = $2, completed_at = $3, last_stage = COALESCE(last_stage, $4),
             completion_digest = $5, completion_result = $6::jsonb
           WHERE attempt_id = $1`,
          [attempt.attempt_id, attemptState, now, beforeIo ? 'connect' : 'final', completionDigest, JSON.stringify(completion)],
        );
        await client.query(
          `UPDATE recipient_work SET state = $4, revision = revision + 1, next_attempt_at = $5,
             leased_from_state = NULL, lease_owner = NULL, lease_assignment_generation = NULL,
             lease_deadline = NULL, current_attempt_id = NULL, updated_at = $6
           WHERE principal = $1 AND message_id = $2 AND recipient_ordinal = $3`,
          [principal, recipient.message_id, recipient.recipient_ordinal, recipientState, nextAttemptAt, now],
        );
        if (beforeIo) result.recoveredBeforeIo += 1;
        else result.uncertainAfterIo += 1;
        if (recipientState === 'dead_lettered') result.deadLettered += 1;
      }
      return { ...result, examined: expired.length };
    });
  }

  async setSuppression(principal, { addressDigest: digest, active }) {
    const row = (await this.pool.query(
      `INSERT INTO suppressions (principal, address_digest, generation, active)
       VALUES ($1,$2,1,$3)
       ON CONFLICT (principal, address_digest) DO UPDATE
         SET generation = suppressions.generation + 1, active = EXCLUDED.active,
             updated_at = statement_timestamp()
       RETURNING generation, active`,
      [principal, digest, active],
    )).rows[0];
    return { addressDigest: digest, generation: number(row.generation), active: row.active };
  }

  async buildLiveResult(client, principal, messageId) {
    const message = (await client.query(
      `SELECT m.*,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(r) ORDER BY r.recipient_ordinal)
           FROM recipient_work r WHERE r.principal = m.principal AND r.message_id = m.message_id
         ), '[]'::jsonb) AS recipient_rows,
         COALESCE((
           SELECT jsonb_agg(to_jsonb(a) ORDER BY a.recipient_ordinal, a.attempt_number)
           FROM attempts a WHERE a.principal = m.principal AND a.message_id = m.message_id
         ), '[]'::jsonb) AS attempt_rows
       FROM messages m WHERE m.principal = $1 AND m.message_id = $2`,
      [principal, messageId],
    )).rows[0];
    if (!message) throw notFound('message not found');
    const recipients = message.recipient_rows.map(publicRecipient);
    const attempts = message.attempt_rows.map(publicAttempt);
    const remoteAcceptedRecipients = recipients.filter((entry) => entry.state === 'remote_accepted').length;
    return {
      messageId,
      messageRevision: number(message.revision),
      state: projectMessageState(recipients.map((entry) => entry.state)),
      recipientCount: recipients.length,
      recipients,
      attempts,
      acceptedAt: iso(message.accepted_at),
      ...publicEvidenceFields(remoteAcceptedRecipients),
    };
  }

  async getLiveMessage(principal, messageId) {
    const client = await this.pool.connect();
    try {
      return await this.buildLiveResult(client, principal, messageId);
    } finally {
      client.release();
    }
  }

  async createStatusSnapshot(principal, input) {
    return this.transaction(async (client) => {
      await advisoryLock(client, [`status:${principal}:${input.queryId}`]);
      const prior = (await client.query(
        'SELECT intent_digest, result FROM status_queries WHERE principal = $1 AND query_id = $2',
        [principal, input.queryId],
      )).rows[0];
      if (prior) {
        if (prior.intent_digest !== input.intentDigest) throw conflict('query identity was already used for changed intent');
        return { created: false, result: prior.result };
      }
      const result = await this.buildLiveResult(client, principal, input.messageId);
      const snapshot = { ...result, queryId: input.queryId, snapshotCreated: true };
      await client.query(
        `INSERT INTO status_queries (principal, query_id, message_id, intent_digest, result)
         VALUES ($1,$2,$3,$4,$5::jsonb)`,
        [principal, input.queryId, input.messageId, input.intentDigest, JSON.stringify(snapshot)],
      );
      return { created: true, result: snapshot };
    });
  }

  async getStatusPage(principal, queryId, offset, limit) {
    const row = (await this.pool.query(
      'SELECT result FROM status_queries WHERE principal = $1 AND query_id = $2',
      [principal, queryId],
    )).rows[0];
    if (!row) throw notFound('status query not found');
    const result = row.result;
    const recipients = result.recipients.slice(offset, offset + limit);
    const nextOffset = offset + recipients.length < result.recipients.length ? offset + recipients.length : null;
    return {
      queryId,
      messageId: result.messageId,
      state: result.state,
      recipientCount: result.recipientCount,
      offset,
      limit,
      nextOffset,
      recipients,
      attempts: result.attempts.filter((attempt) => recipients.some((entry) => entry.ordinal === attempt.recipientOrdinal)),
      ...publicEvidenceFields(result.remoteAcceptedRecipients),
    };
  }

  async getState(principal) {
    const stateRows = (await this.pool.query(
      `SELECT state, COUNT(*)::int AS count FROM recipient_work WHERE principal = $1 GROUP BY state ORDER BY state`,
      [principal],
    )).rows;
    const timing = (await this.pool.query(
      `SELECT
         COUNT(*) FILTER (WHERE state IN ('leased','attempting') AND lease_deadline <= statement_timestamp())::int AS expired_leases,
         EXTRACT(EPOCH FROM (
           statement_timestamp() - MIN(next_attempt_at)
             FILTER (WHERE state IN ('queued','retry_scheduled') AND next_attempt_at <= statement_timestamp())
         )) AS oldest_due_seconds
       FROM recipient_work WHERE principal = $1`,
      [principal],
    )).rows[0];
    const invariant = (await this.pool.query(
      `SELECT COUNT(*)::int AS gap FROM recipient_work r
       WHERE principal = $1 AND (
         (state = 'attempting' AND current_attempt_id IS NULL)
         OR (state <> 'attempting' AND current_attempt_id IS NOT NULL)
         OR (state IN ('leased','attempting') AND lease_owner IS NULL)
         OR (state NOT IN ('leased','attempting') AND lease_owner IS NOT NULL)
       )`,
      [principal],
    )).rows[0];
    return {
      authority: 'postgresql',
      states: Object.fromEntries(stateRows.map((row) => [row.state, number(row.count)])),
      expiredLeases: number(timing.expired_leases),
      oldestDueSeconds: timing.oldest_due_seconds === null ? null : Math.max(0, Number(timing.oldest_due_seconds)),
      invariantGap: number(invariant.gap),
      mailboxDeliveryProved: false,
      inboxPlacementProved: false,
      readProved: false,
      externalAcceptanceProved: false,
    };
  }

  async reset() {
    await this.pool.query(
      `TRUNCATE status_queries, suppressions, attempts, worker_assignments, recipient_work,
         mutation_receipts, messages RESTART IDENTITY CASCADE`,
    );
  }
}
