import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCanonicalMessage,
  parseCompletion,
  parseSubmission,
  parseSuppression,
} from '../../src/contracts.js';

function submission(overrides = {}) {
  return {
    requestKey: 'req_example0001',
    messageId: 'msg_example0001',
    envelopeFrom: 'sender@origin.invalid',
    headerFrom: 'author@origin.invalid',
    headerTo: ['reader@alpha.invalid'],
    recipients: ['reader@alpha.invalid', 'archive@beta.invalid'],
    subject: 'synthetic receipt',
    body: 'line one\n.line two',
    ...overrides,
  };
}

test('submission canonicalization is stable and preserves ordered recipient intent', () => {
  const first = parseSubmission(submission());
  const replay = parseSubmission(submission());
  assert.equal(first.intentDigest, replay.intentDigest);
  assert.equal(first.contentDigest, replay.contentDigest);
  assert.match(first.canonicalContent, /\r\n\.line two\r\n$/);
  const reordered = parseSubmission(submission({ recipients: [...submission().recipients].reverse() }));
  assert.notEqual(first.intentDigest, reordered.intentDigest);
  assert.equal(first.contentDigest, reordered.contentDigest);
});

test('generated content separates envelope identity from visible headers', () => {
  const input = parseSubmission(submission({
    envelopeFrom: 'bounce@transport.invalid',
    headerFrom: 'author@display.invalid',
  }));
  assert.match(input.canonicalContent, /^From: author@display\.invalid\r\n/);
  assert.doesNotMatch(input.canonicalContent, /bounce@transport\.invalid/);
});

test('closed shapes and synthetic-only address policy reject unsafe input', () => {
  assert.throws(() => parseSubmission({ ...submission(), extra: true }), /invalid shape/);
  assert.throws(() => parseSubmission(submission({ envelopeFrom: 'person@example.com' })), /synthetic/);
  assert.throws(() => parseSubmission(submission({ subject: 'ok\r\nBcc: leak@bad.invalid' })), /printable ASCII/);
  assert.throws(() => parseSubmission(submission({ body: 'ok\r\nInjected: yes' })), /printable ASCII and LF/);
  assert.throws(() => parseSubmission(submission({ body: 'x'.repeat(201) })), /line exceeds/);
  assert.throws(() => parseSubmission(submission({ recipients: ['same@alpha.invalid', 'same@alpha.invalid'] })), /duplicate/);
  assert.throws(() => buildCanonicalMessage({ ...submission(), body: 'x'.repeat(8_100) }), /exceeds/);
});

test('suppression stores a digest rather than requiring address output', () => {
  const parsed = parseSuppression({ address: 'reader@alpha.invalid', active: true });
  assert.equal(parsed.addressDigest.length, 64);
  assert.equal(parsed.active, true);
});

test('SMTP completion contract accepts numeric stage evidence only', () => {
  const parsed = parseCompletion({
    attemptId: 'att_0123456789abcdef0123456789abcdef',
    workerId: 'wrk_example0001',
    generation: 1,
    leaseGeneration: 2,
    smtpResult: {
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
    },
  });
  assert.equal(parsed.smtpResult.finalCode, 250);
  assert.throws(() => parseCompletion({ ...parsed, smtpResult: { ...parsed.smtpResult, replyText: 'sensitive' } }), /invalid shape/);
});
