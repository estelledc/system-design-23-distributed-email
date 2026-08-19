import { sha256 } from './crypto.js';

export const MAX_ATTEMPTS = 3;

export function addressDigest(address) {
  return sha256(address);
}

export function bucketForAddress(address) {
  const domain = address.slice(address.lastIndexOf('@') + 1);
  const value = Number.parseInt(sha256(domain).slice(0, 8), 16) % 4;
  return `bucket_${value}`;
}

export function classifySmtpResult(result) {
  if (result.uncertain || (result.dataBytesSent && result.finalCode === null)) {
    return { attemptState: 'unknown_after_io', action: 'unknown' };
  }
  const stageCode = result.finalCode ?? result.dataCode ?? result.rcptCode ?? result.mailCode ?? result.ehloCode ?? result.greetingCode;
  if (stageCode !== null) {
    const klass = Math.floor(stageCode / 100);
    if (result.finalCode !== null && klass === 2) return { attemptState: 'remote_accepted', action: 'remote_accepted' };
    if (klass === 4) return { attemptState: 'transient_failure', action: 'retry' };
    if (klass === 5) return { attemptState: 'permanent_failure', action: 'permanent_rejected' };
  }
  if (result.networkFailure && !result.dataBytesSent) return { attemptState: 'network_failure', action: 'retry' };
  return { attemptState: 'unknown_after_io', action: 'unknown' };
}

export function backoffSeconds(attemptNumber, baseSeconds = 1800) {
  return baseSeconds * (2 ** Math.max(0, attemptNumber - 1));
}

export function projectMessageState(recipientStates) {
  if (recipientStates.length === 0) return 'empty';
  if (recipientStates.every((state) => state === 'remote_accepted')) return 'all_remote_accepted';
  if (recipientStates.some((state) => state === 'unknown_after_io')) return 'uncertain';
  const active = new Set(['queued', 'leased', 'attempting', 'retry_scheduled']);
  if (recipientStates.some((state) => active.has(state))) return 'in_progress';
  if (recipientStates.every((state) => ['permanent_rejected', 'suppressed', 'dead_lettered'].includes(state))) return 'terminal_without_remote_acceptance';
  return 'mixed_terminal';
}

export function publicEvidenceFields(remoteAcceptedRecipients = 0) {
  return {
    remoteAcceptedRecipients,
    mailboxDeliveredRecipients: 0,
    inboxPlacedRecipients: 0,
    readRecipients: 0,
    externalAcceptanceProved: false,
  };
}
