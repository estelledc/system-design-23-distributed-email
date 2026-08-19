import { digestObject, sha256 } from './crypto.js';
import { invalid } from './errors.js';

const IDENTIFIER = /^(?:msg|req|qry|wrk)_[a-z0-9]{8,40}$/;
const ATTEMPT_ID = /^att_[a-f0-9]{32}$/;
const ADDRESS = /^[a-z0-9][a-z0-9._+-]{0,63}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.invalid$/;
const BUCKETS = new Set(['bucket_0', 'bucket_1', 'bucket_2', 'bucket_3']);
const STAGES = new Set(['connect', 'greeting', 'ehlo', 'mail', 'rcpt', 'data', 'final']);

function object(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw invalid(`${label} must be an object`);
  return value;
}

function exactKeys(value, allowed, label) {
  const extra = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = allowed.filter((key) => !(key in value));
  if (extra.length || missing.length) throw invalid(`${label} has an invalid shape`);
}

export function parseIdentifier(value, prefix, label = prefix) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value) || !value.startsWith(`${prefix}_`)) {
    throw invalid(`${label} has an invalid identifier`);
  }
  return value;
}

export function parseAttemptId(value) {
  if (typeof value !== 'string' || !ATTEMPT_ID.test(value)) throw invalid('attemptId has an invalid identifier');
  return value;
}

export function parseAddress(value, label = 'address') {
  if (typeof value !== 'string' || value.length > 254 || value !== value.toLowerCase() || !ADDRESS.test(value)) {
    throw invalid(`${label} must be a lowercase synthetic .invalid mailbox`);
  }
  const [local, ...domainParts] = value.split('@');
  const domain = domainParts.join('@');
  if (local.endsWith('.') || local.includes('..') || domain.split('.').some((part) => !part || part.startsWith('-') || part.endsWith('-'))) {
    throw invalid(`${label} has an invalid synthetic mailbox shape`);
  }
  return value;
}

function parseAddressList(value, label, minimum = 1) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 8) throw invalid(`${label} must contain ${minimum} to 8 addresses`);
  const parsed = value.map((entry, index) => parseAddress(entry, `${label}[${index}]`));
  if (new Set(parsed).size !== parsed.length) throw invalid(`${label} contains a duplicate address`);
  return parsed;
}

function parseSubject(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 120 || /[^\x20-\x7e]/.test(value)) {
    throw invalid('subject must be at most 120 printable ASCII bytes');
  }
  return value;
}

function parseBody(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) > 4096 || /\r/.test(value) || /[^\x20-\x7e\n]/.test(value)) {
    throw invalid('body must be at most 4096 bytes of printable ASCII and LF');
  }
  if (value.split('\n').some((line) => Buffer.byteLength(line) > 200)) throw invalid('body line exceeds 200 bytes');
  return value;
}

export function buildCanonicalMessage(input) {
  const normalizedBody = input.body.replaceAll('\n', '\r\n');
  const lines = [
    `From: ${input.headerFrom}`,
    `To: ${input.headerTo.join(', ')}`,
    `Subject: ${input.subject}`,
    `Message-ID: <${input.messageId}@lab.invalid>`,
    'X-System-Design-Lab: distributed-email-v0.1',
    '',
    normalizedBody,
  ];
  const content = `${lines.join('\r\n')}\r\n`;
  if (Buffer.byteLength(content) > 8192) throw invalid('generated message exceeds 8192 bytes');
  return content;
}

export function parseSubmission(value) {
  const input = object(value, 'submission');
  exactKeys(input, ['requestKey', 'messageId', 'envelopeFrom', 'headerFrom', 'headerTo', 'recipients', 'subject', 'body'], 'submission');
  const parsed = {
    requestKey: parseIdentifier(input.requestKey, 'req', 'requestKey'),
    messageId: parseIdentifier(input.messageId, 'msg', 'messageId'),
    envelopeFrom: parseAddress(input.envelopeFrom, 'envelopeFrom'),
    headerFrom: parseAddress(input.headerFrom, 'headerFrom'),
    headerTo: parseAddressList(input.headerTo, 'headerTo'),
    recipients: parseAddressList(input.recipients, 'recipients'),
    subject: parseSubject(input.subject),
    body: parseBody(input.body),
  };
  const canonicalContent = buildCanonicalMessage(parsed);
  const contentDigest = sha256(canonicalContent);
  const intentDigest = digestObject({
    messageId: parsed.messageId,
    envelopeFrom: parsed.envelopeFrom,
    headerFrom: parsed.headerFrom,
    headerTo: parsed.headerTo,
    recipients: parsed.recipients,
    subject: parsed.subject,
    contentDigest,
  });
  return { ...parsed, canonicalContent, contentDigest, intentDigest };
}

export function parseStatusQuery(value) {
  const input = object(value, 'status query');
  exactKeys(input, ['queryId', 'messageId'], 'status query');
  const queryId = parseIdentifier(input.queryId, 'qry', 'queryId');
  const messageId = parseIdentifier(input.messageId, 'msg', 'messageId');
  return { queryId, messageId, intentDigest: digestObject({ queryId, messageId }) };
}

export function parseAssignment(value) {
  const input = object(value, 'assignment');
  exactKeys(input, ['bucket', 'workerId'], 'assignment');
  if (!BUCKETS.has(input.bucket)) throw invalid('bucket is not supported');
  return { bucket: input.bucket, workerId: parseIdentifier(input.workerId, 'wrk', 'workerId') };
}

export function parseGeneration(value, label = 'generation') {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${label} must be a positive safe integer`);
  return value;
}

export function parseClaim(value) {
  const input = object(value, 'claim');
  exactKeys(input, ['bucket', 'workerId', 'generation', 'leaseSeconds'], 'claim');
  const assignment = parseAssignment({ bucket: input.bucket, workerId: input.workerId });
  if (!Number.isFinite(input.leaseSeconds) || input.leaseSeconds < 0.05 || input.leaseSeconds > 300) {
    throw invalid('leaseSeconds must be between 0.05 and 300');
  }
  return { ...assignment, generation: parseGeneration(input.generation), leaseSeconds: input.leaseSeconds };
}

export function parseAttemptPreparation(value) {
  const input = object(value, 'attempt preparation');
  exactKeys(input, ['messageId', 'recipientOrdinal', 'workerId', 'generation', 'leaseGeneration'], 'attempt preparation');
  if (!Number.isInteger(input.recipientOrdinal) || input.recipientOrdinal < 0 || input.recipientOrdinal > 7) {
    throw invalid('recipientOrdinal must be between 0 and 7');
  }
  return {
    messageId: parseIdentifier(input.messageId, 'msg', 'messageId'),
    recipientOrdinal: input.recipientOrdinal,
    workerId: parseIdentifier(input.workerId, 'wrk', 'workerId'),
    generation: parseGeneration(input.generation),
    leaseGeneration: parseGeneration(input.leaseGeneration, 'leaseGeneration'),
  };
}

export function parseAttemptMutation(value) {
  const input = object(value, 'attempt mutation');
  exactKeys(input, ['attemptId', 'workerId', 'generation', 'leaseGeneration'], 'attempt mutation');
  return {
    attemptId: parseAttemptId(input.attemptId),
    workerId: parseIdentifier(input.workerId, 'wrk', 'workerId'),
    generation: parseGeneration(input.generation),
    leaseGeneration: parseGeneration(input.leaseGeneration, 'leaseGeneration'),
  };
}

function parseReplyCode(value, label) {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 200 || value > 599) throw invalid(`${label} is not an SMTP reply code`);
  return value;
}

export function parseSmtpResult(value) {
  const input = object(value, 'smtpResult');
  exactKeys(input, [
    'lastStage', 'dataBytesSent', 'uncertain', 'networkFailure', 'greetingCode', 'ehloCode', 'mailCode', 'rcptCode',
    'dataCode', 'finalCode', 'enhancedStatus',
  ], 'smtpResult');
  if (!STAGES.has(input.lastStage)) throw invalid('smtpResult lastStage is invalid');
  if (typeof input.dataBytesSent !== 'boolean' || typeof input.uncertain !== 'boolean' || typeof input.networkFailure !== 'boolean') {
    throw invalid('smtpResult flags must be boolean');
  }
  if (input.enhancedStatus !== null && (typeof input.enhancedStatus !== 'string' || !/^[245]\.\d{1,3}\.\d{1,3}$/.test(input.enhancedStatus))) {
    throw invalid('enhancedStatus is invalid');
  }
  return {
    lastStage: input.lastStage,
    dataBytesSent: input.dataBytesSent,
    uncertain: input.uncertain,
    networkFailure: input.networkFailure,
    greetingCode: parseReplyCode(input.greetingCode, 'greetingCode'),
    ehloCode: parseReplyCode(input.ehloCode, 'ehloCode'),
    mailCode: parseReplyCode(input.mailCode, 'mailCode'),
    rcptCode: parseReplyCode(input.rcptCode, 'rcptCode'),
    dataCode: parseReplyCode(input.dataCode, 'dataCode'),
    finalCode: parseReplyCode(input.finalCode, 'finalCode'),
    enhancedStatus: input.enhancedStatus,
  };
}

export function parseCompletion(value) {
  const input = object(value, 'attempt completion');
  exactKeys(input, ['attemptId', 'workerId', 'generation', 'leaseGeneration', 'smtpResult'], 'attempt completion');
  return {
    ...parseAttemptMutation({
      attemptId: input.attemptId,
      workerId: input.workerId,
      generation: input.generation,
      leaseGeneration: input.leaseGeneration,
    }),
    smtpResult: parseSmtpResult(input.smtpResult),
  };
}

export function parseRecovery(value) {
  const input = object(value, 'recovery');
  exactKeys(input, ['bucket', 'workerId', 'generation', 'limit'], 'recovery');
  const assignment = parseAssignment({ bucket: input.bucket, workerId: input.workerId });
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 32) throw invalid('limit must be between 1 and 32');
  return { ...assignment, generation: parseGeneration(input.generation), limit: input.limit };
}

export function parseSuppression(value) {
  const input = object(value, 'suppression');
  exactKeys(input, ['address', 'active'], 'suppression');
  if (typeof input.active !== 'boolean') throw invalid('suppression active must be boolean');
  const address = parseAddress(input.address);
  return { address, addressDigest: sha256(address), active: input.active };
}

export function parsePage(offsetValue, limitValue) {
  const offset = offsetValue === undefined ? 0 : Number(offsetValue);
  const limit = limitValue === undefined ? 2 : Number(limitValue);
  if (!Number.isInteger(offset) || offset < 0 || offset > 64) throw invalid('offset must be an integer between 0 and 64');
  if (!Number.isInteger(limit) || limit < 1 || limit > 8) throw invalid('limit must be an integer between 1 and 8');
  return { offset, limit };
}

export function bucketNames() {
  return [...BUCKETS];
}
