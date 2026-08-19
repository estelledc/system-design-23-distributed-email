import { createHttpServer } from './http.js';
import { createPool, installSchema, MailRepository } from './repository.js';
import { MailService } from './service.js';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main() {
  const command = process.argv[2] ?? 'serve';
  const pool = createPool(required('DATABASE_URL'));
  await installSchema(pool);
  const repository = new MailRepository(pool, {
    retryBaseSeconds: Number(process.env.MAIL_RETRY_BASE_SECONDS ?? 1800),
    maxRetryAgeSeconds: Number(process.env.MAIL_MAX_RETRY_AGE_SECONDS ?? 432000),
  });
  const service = new MailService(repository, {
    principal: process.env.MAIL_PRINCIPAL ?? 'tenant_lab',
    smtpPort: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : null,
    smtpTimeoutMs: Number(process.env.SMTP_TIMEOUT_MS ?? 2000),
  });

  if (command === 'worker-once') {
    try {
      const result = await service.deliverOne({
        bucket: required('MAIL_BUCKET'),
        workerId: required('MAIL_WORKER_ID'),
        generation: Number(required('MAIL_ASSIGNMENT_GENERATION')),
        leaseSeconds: Number(process.env.MAIL_LEASE_SECONDS ?? 2),
      });
      process.stdout.write(`${JSON.stringify({ event: 'worker_result', kind: result.kind, state: result.completion?.state ?? null })}\n`);
    } finally {
      await pool.end();
    }
    return;
  }

  if (command !== 'serve') throw new Error('command must be serve or worker-once');
  const server = createHttpServer({ service, token: required('MAIL_API_TOKEN') });
  const port = Number(process.env.PORT ?? 3000);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  process.stdout.write(`${JSON.stringify({ event: 'server_ready', port })}\n`);
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };
  process.once('SIGTERM', () => stop().then(() => process.exit(0)));
  process.once('SIGINT', () => stop().then(() => process.exit(0)));
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ event: 'fatal', error: error.name })}\n`);
  process.exitCode = 1;
});
