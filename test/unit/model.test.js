import assert from 'node:assert/strict';
import test from 'node:test';
import {
  backoffSeconds,
  bucketForAddress,
  classifySmtpResult,
  projectMessageState,
  publicEvidenceFields,
} from '../../src/model.js';

function result(overrides = {}) {
  return {
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
    ...overrides,
  };
}

test('SMTP outcome classification keeps success, transient, permanent, and uncertainty distinct', () => {
  assert.deepEqual(classifySmtpResult(result()), { attemptState: 'remote_accepted', action: 'remote_accepted' });
  assert.deepEqual(classifySmtpResult(result({ finalCode: 451, enhancedStatus: '4.3.0' })), { attemptState: 'transient_failure', action: 'retry' });
  assert.deepEqual(classifySmtpResult(result({ finalCode: 550, enhancedStatus: '5.1.1' })), { attemptState: 'permanent_failure', action: 'permanent_rejected' });
  assert.deepEqual(classifySmtpResult(result({ finalCode: null, uncertain: true })), { attemptState: 'unknown_after_io', action: 'unknown' });
  assert.deepEqual(classifySmtpResult(result({
    lastStage: 'connect', dataBytesSent: false, finalCode: null, networkFailure: true, enhancedStatus: null,
    greetingCode: null, ehloCode: null, mailCode: null, rcptCode: null, dataCode: null,
  })), { attemptState: 'network_failure', action: 'retry' });
});

test('response loss after bytes is never classified as safe retry', () => {
  for (let index = 0; index < 2_000; index += 1) {
    const classified = classifySmtpResult(result({ finalCode: null, uncertain: index % 2 === 0, networkFailure: true }));
    assert.equal(classified.action, 'unknown');
  }
});

test('bucket mapping and backoff are deterministic and bounded by caller policy', () => {
  assert.equal(bucketForAddress('one@alpha.invalid'), bucketForAddress('two@alpha.invalid'));
  assert.match(bucketForAddress('one@alpha.invalid'), /^bucket_[0-3]$/);
  assert.deepEqual([1, 2, 3].map((attempt) => backoffSeconds(attempt, 10)), [10, 20, 40]);
});

test('message projection does not turn mixed or unknown outcomes into delivery', () => {
  assert.equal(projectMessageState(['remote_accepted', 'remote_accepted']), 'all_remote_accepted');
  assert.equal(projectMessageState(['remote_accepted', 'retry_scheduled']), 'in_progress');
  assert.equal(projectMessageState(['remote_accepted', 'unknown_after_io']), 'uncertain');
  assert.equal(projectMessageState(['permanent_rejected', 'suppressed']), 'terminal_without_remote_acceptance');
  assert.equal(projectMessageState(['remote_accepted', 'permanent_rejected']), 'mixed_terminal');
  assert.deepEqual(publicEvidenceFields(2), {
    remoteAcceptedRecipients: 2,
    mailboxDeliveredRecipients: 0,
    inboxPlacedRecipients: 0,
    readRecipients: 0,
    externalAcceptanceProved: false,
  });
});
