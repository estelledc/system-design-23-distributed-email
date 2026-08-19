import { chmod, writeFile } from 'node:fs/promises';
import { createSmtpOracle } from '../src/smtp-oracle.js';

const ledgerPath = process.env.ORACLE_LEDGER_PATH;
const readyPath = process.env.ORACLE_READY_PATH;
if (!ledgerPath || !readyPath) throw new Error('ORACLE_LEDGER_PATH and ORACLE_READY_PATH are required');

const oracle = await createSmtpOracle({ ledgerPath, port: Number(process.env.ORACLE_PORT ?? 0) });
await writeFile(readyPath, `${JSON.stringify({ port: oracle.port })}\n`, { mode: 0o600 });
await chmod(readyPath, 0o600);
process.stdout.write(`${JSON.stringify({ event: 'oracle_ready', port: oracle.port })}\n`);

async function stop() {
  await oracle.close();
  process.exit(0);
}

process.once('SIGTERM', () => stop().catch(() => process.exit(1)));
process.once('SIGINT', () => stop().catch(() => process.exit(1)));
