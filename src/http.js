import { randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { AppError, unavailable } from './errors.js';

const MAX_BODY_BYTES = 16_384;

function requestId() {
  return `http_${randomUUID().replaceAll('-', '').slice(0, 20)}`;
}

function sendJson(response, status, body, id) {
  const payload = JSON.stringify({ requestId: id, ...body });
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(payload);
}

function authorized(request, token) {
  const value = request.headers.authorization;
  if (typeof value !== 'string' || !value.startsWith('Bearer ')) return false;
  const received = Buffer.from(value.slice(7));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

async function readJson(request) {
  if (!request.headers['content-type']?.toLowerCase().startsWith('application/json')) {
    throw new AppError('invalid_input', 'content-type must be application/json', 400);
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new AppError('invalid_input', 'request body exceeds limit', 400);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError('invalid_input', 'request body is not valid JSON', 400);
  }
}

function routeFor(method, pathname) {
  if (method === 'GET' && pathname === '/healthz') return { name: 'health' };
  if (method === 'GET' && pathname === '/readyz') return { name: 'ready' };
  if (method === 'POST' && pathname === '/v1/messages') return { name: 'submit' };
  if (method === 'POST' && pathname === '/v1/status-queries') return { name: 'status.create' };
  if (method === 'POST' && pathname === '/v1/worker-assignments') return { name: 'assignment.create' };
  if (method === 'POST' && pathname === '/v1/recipient-claims') return { name: 'claim.create' };
  if (method === 'POST' && pathname === '/v1/attempts') return { name: 'attempt.prepare' };
  if (method === 'POST' && pathname === '/v1/recoveries') return { name: 'recovery.create' };
  if (method === 'POST' && pathname === '/v1/suppressions') return { name: 'suppression.set' };
  if (method === 'GET' && pathname === '/v1/state') return { name: 'state.get' };
  let match = /^\/v1\/messages\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && match) return { name: 'message.get', id: decodeURIComponent(match[1]) };
  match = /^\/v1\/mutation-receipts\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && match) return { name: 'receipt.get', id: decodeURIComponent(match[1]) };
  match = /^\/v1\/status-queries\/([^/]+)$/.exec(pathname);
  if (method === 'GET' && match) return { name: 'status.page', id: decodeURIComponent(match[1]) };
  match = /^\/v1\/attempts\/([^/]+)\/io-started$/.exec(pathname);
  if (method === 'POST' && match) return { name: 'attempt.io', id: decodeURIComponent(match[1]) };
  match = /^\/v1\/attempts\/([^/]+)\/complete$/.exec(pathname);
  if (method === 'POST' && match) return { name: 'attempt.complete', id: decodeURIComponent(match[1]) };
  return null;
}

export function createHttpServer({ service, token, logger = (entry) => process.stdout.write(`${JSON.stringify(entry)}\n`) }) {
  if (typeof token !== 'string' || token.length < 16) throw new Error('MAIL_API_TOKEN must have at least 16 characters');
  return http.createServer(async (request, response) => {
    const id = requestId();
    let route = null;
    let status = 500;
    try {
      const url = new URL(request.url, 'http://loopback.invalid');
      route = routeFor(request.method, url.pathname);
      if (!route) throw new AppError('not_found', 'route not found', 404);
      if (route.name === 'health') {
        status = 200;
        sendJson(response, status, { status: 'ok' }, id);
        return;
      }
      if (!authorized(request, token)) throw new AppError('unauthorized', 'authorization required', 401);

      let result;
      if (route.name === 'ready' || route.name === 'state.get') result = await service.state();
      else if (route.name === 'submit') result = await service.submit(await readJson(request));
      else if (route.name === 'message.get') result = await service.getMessage(route.id);
      else if (route.name === 'receipt.get') result = await service.getReceipt(route.id);
      else if (route.name === 'status.create') result = await service.createStatusQuery(await readJson(request));
      else if (route.name === 'status.page') result = await service.getStatusPage(route.id, url.searchParams.get('offset') ?? undefined, url.searchParams.get('limit') ?? undefined);
      else if (route.name === 'assignment.create') result = await service.assign(await readJson(request));
      else if (route.name === 'claim.create') result = await service.claim(await readJson(request));
      else if (route.name === 'attempt.prepare') result = await service.prepare(await readJson(request));
      else if (route.name === 'attempt.io') result = await service.ioStarted({ ...(await readJson(request)), attemptId: route.id });
      else if (route.name === 'attempt.complete') result = await service.complete({ ...(await readJson(request)), attemptId: route.id });
      else if (route.name === 'recovery.create') result = await service.recover(await readJson(request));
      else if (route.name === 'suppression.set') result = await service.suppress(await readJson(request));
      else throw new AppError('not_found', 'route not found', 404);

      status = route.name === 'submit' || route.name === 'status.create'
        ? (result.created ? 201 : 200)
        : 200;
      sendJson(response, status, { data: result.result ?? result }, id);
    } catch (error) {
      const safe = error instanceof AppError ? error : unavailable();
      status = safe.status;
      sendJson(response, status, { error: { code: safe.code, message: safe.message } }, id);
    } finally {
      logger({ event: 'http_response', route: route?.name ?? 'unmatched', status });
    }
  });
}
