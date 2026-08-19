import assert from 'node:assert/strict';
import test from 'node:test';
import { createHttpServer } from '../../src/http.js';

const token = 'unit-synthetic-token-0001';

async function withServer(service, run) {
  const logs = [];
  const server = createHttpServer({ service, token, logger: (entry) => logs.push(entry) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    await run(`http://127.0.0.1:${port}`, logs);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('HTTP route authenticates and distinguishes first commit from replay', async () => {
  let calls = 0;
  await withServer({
    submit: async () => ({ created: calls++ === 0, result: { durableAccepted: true, remoteAcceptedRecipients: 0 } }),
  }, async (base, logs) => {
    const unauthorized = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unauthorized.status, 401);
    const request = () => fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal((await request()).status, 201);
    assert.equal((await request()).status, 200);
    assert.deepEqual(logs.map((entry) => entry.route), ['submit', 'submit', 'submit']);
    assert.ok(logs.every((entry) => !JSON.stringify(entry).includes(token)));
  });
});

test('HTTP generic failures are redacted and body size is bounded', async () => {
  await withServer({ submit: async () => { throw new Error('database host and sensitive value'); } }, async (base) => {
    const failed = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(failed.status, 503);
    const failedBody = await failed.json();
    assert.equal(failedBody.error.code, 'authority_unavailable');
    assert.doesNotMatch(JSON.stringify(failedBody), /database host|sensitive/);

    const oversized = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x'.repeat(17_000) }),
    });
    assert.equal(oversized.status, 400);
  });
});
