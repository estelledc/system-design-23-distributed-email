import { createHash } from 'node:crypto';

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

export function digestObject(value) {
  return sha256(stableJson(value));
}

export function makeAttemptId(principal, messageId, ordinal, attemptNumber) {
  return `att_${sha256(`${principal}\0${messageId}\0${ordinal}\0${attemptNumber}`).slice(0, 32)}`;
}
