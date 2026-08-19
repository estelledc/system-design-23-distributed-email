import {
  parseAssignment,
  parseAttemptMutation,
  parseAttemptPreparation,
  parseClaim,
  parseCompletion,
  parseIdentifier,
  parsePage,
  parseRecovery,
  parseStatusQuery,
  parseSubmission,
  parseSuppression,
} from './contracts.js';
import { sendSmtpMessage } from './smtp-client.js';

function crashIf(name) {
  if (process.env[name] === '1') process.kill(process.pid, 'SIGKILL');
}

export class MailService {
  constructor(repository, { principal = 'tenant_lab', smtpHost = '127.0.0.1', smtpPort = null, smtpTimeoutMs = 2_000 } = {}) {
    this.repository = repository;
    this.principal = principal;
    this.smtpHost = smtpHost;
    this.smtpPort = smtpPort;
    this.smtpTimeoutMs = smtpTimeoutMs;
  }

  async submit(value) {
    const result = await this.repository.submitMessage(this.principal, parseSubmission(value));
    crashIf('MAIL_CRASH_AFTER_SUBMIT_COMMIT');
    return result;
  }

  async getReceipt(requestKey) {
    return this.repository.getMutationReceipt(this.principal, parseIdentifier(requestKey, 'req', 'requestKey'));
  }

  async getMessage(messageId) {
    return this.repository.getLiveMessage(this.principal, parseIdentifier(messageId, 'msg', 'messageId'));
  }

  async createStatusQuery(value) {
    return this.repository.createStatusSnapshot(this.principal, parseStatusQuery(value));
  }

  async getStatusPage(queryId, offset, limit) {
    const parsedQueryId = parseIdentifier(queryId, 'qry', 'queryId');
    const page = parsePage(offset, limit);
    return this.repository.getStatusPage(this.principal, parsedQueryId, page.offset, page.limit);
  }

  async assign(value) {
    return this.repository.assignWorker(parseAssignment(value));
  }

  async claim(value) {
    return this.repository.claimNext(this.principal, parseClaim(value));
  }

  async prepare(value) {
    const result = await this.repository.prepareAttempt(this.principal, parseAttemptPreparation(value));
    crashIf('MAIL_CRASH_AFTER_ATTEMPT_PREPARE_COMMIT');
    return result;
  }

  async ioStarted(value) {
    return this.repository.markIoStarted(this.principal, parseAttemptMutation(value));
  }

  async complete(value) {
    const result = await this.repository.completeAttempt(this.principal, parseCompletion(value));
    crashIf('MAIL_CRASH_AFTER_COMPLETION_COMMIT');
    return result;
  }

  async recover(value) {
    return this.repository.recoverExpired(this.principal, parseRecovery(value));
  }

  async suppress(value) {
    return this.repository.setSuppression(this.principal, parseSuppression(value));
  }

  async state() {
    return this.repository.getState(this.principal);
  }

  async deliverOne({ bucket, workerId, generation, leaseSeconds = 2 }) {
    if (!this.smtpPort) throw new Error('SMTP port is required for worker delivery');
    const claimResult = await this.claim({ bucket, workerId, generation, leaseSeconds });
    if (!claimResult.claim) return { kind: 'idle', suppressedCount: claimResult.suppressedCount };
    const claim = claimResult.claim;
    const attempt = await this.prepare({
      messageId: claim.messageId,
      recipientOrdinal: claim.ordinal,
      workerId,
      generation,
      leaseGeneration: claim.leaseGeneration,
    });
    if (attempt.suppressed) return { kind: 'suppressed', suppressedCount: claimResult.suppressedCount + 1, completion: attempt };
    await this.ioStarted({ attemptId: attempt.attemptId, workerId, generation, leaseGeneration: claim.leaseGeneration });
    const smtpResult = await sendSmtpMessage({
      host: this.smtpHost,
      port: this.smtpPort,
      envelopeFrom: claim.envelopeFrom,
      envelopeTo: claim.envelopeTo,
      canonicalContent: claim.canonicalContent,
      timeoutMs: this.smtpTimeoutMs,
    });
    if (smtpResult.finalCode !== null && Math.floor(smtpResult.finalCode / 100) === 2) {
      crashIf('MAIL_CRASH_AFTER_REMOTE_REPLY');
    }
    const completion = await this.complete({
      attemptId: attempt.attemptId,
      workerId,
      generation,
      leaseGeneration: claim.leaseGeneration,
      smtpResult,
    });
    return { kind: 'completed', suppressedCount: claimResult.suppressedCount, completion };
  }
}
