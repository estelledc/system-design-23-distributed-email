import net from 'node:net';
import { open, readFile } from 'node:fs/promises';
import { sha256 } from './crypto.js';

async function appendLedger(path, entry) {
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.write(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function recipientMode(address) {
  const local = address.slice(0, address.indexOf('@'));
  if (local.startsWith('temp')) return 'transient';
  if (local.startsWith('reject')) return 'permanent';
  if (local.startsWith('drop')) return 'accept_without_reply';
  return 'accept';
}

function unstuff(lines) {
  return lines.map((line) => (line.startsWith('..') ? line.slice(1) : line)).join('\r\n') + '\r\n';
}

export async function createSmtpOracle({ ledgerPath, host = '127.0.0.1', port = 0 }) {
  if (!ledgerPath) throw new Error('ledgerPath is required');
  if (host !== '127.0.0.1') throw new Error('oracle permits loopback only');
  const stats = { connections: 0, transactions: 0, accepted: 0, transient: 0, permanent: 0, droppedReplies: 0 };
  const sockets = new Set();
  const server = net.createServer((socket) => {
    stats.connections += 1;
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.setEncoding('utf8');
    socket.setNoDelay(true);
    socket.on('error', () => {
      // Connection reset is an expected fixture outcome; no peer data is logged.
    });
    socket.write('220 oracle.invalid ESMTP synthetic-lab\r\n');
    let buffer = '';
    let phase = 'command';
    let envelopeFrom = null;
    let recipient = null;
    let dataLines = [];
    let chain = Promise.resolve();

    async function handleLine(line) {
      if (phase === 'data') {
        if (line !== '.') {
          dataLines.push(line);
          if (Buffer.byteLength(dataLines.join('\r\n')) > 16_384) {
            socket.write('552 5.3.4 message too large\r\n');
            socket.end();
          }
          return;
        }
        const content = unstuff(dataLines);
        const mode = recipientMode(recipient);
        stats.transactions += 1;
        const entry = {
          event: 'smtp_transaction',
          sequence: stats.transactions,
          senderDigest: sha256(envelopeFrom),
          recipientDigest: sha256(recipient),
          contentDigest: sha256(content),
          outcome: mode,
          acceptedResponsibility: mode === 'accept' || mode === 'accept_without_reply',
        };
        await appendLedger(ledgerPath, entry);
        if (mode === 'transient') {
          stats.transient += 1;
          socket.write('451 4.3.0 synthetic transient failure\r\n');
        } else if (mode === 'permanent') {
          stats.permanent += 1;
          socket.write('550 5.1.1 synthetic permanent failure\r\n');
        } else if (mode === 'accept_without_reply') {
          stats.accepted += 1;
          stats.droppedReplies += 1;
          socket.destroy();
        } else {
          stats.accepted += 1;
          socket.write('250 2.0.0 accepted responsibility\r\n');
        }
        phase = 'done';
        return;
      }

      if (/^(?:EHLO|HELO) [^\s]+$/.test(line)) {
        socket.write('250-oracle.invalid\r\n250 SIZE 16384\r\n');
        return;
      }
      const mail = /^MAIL FROM:<([^<>\r\n]+)>$/.exec(line);
      if (mail) {
        envelopeFrom = mail[1];
        socket.write('250 2.1.0 sender accepted\r\n');
        return;
      }
      const rcpt = /^RCPT TO:<([^<>\r\n]+)>$/.exec(line);
      if (rcpt && envelopeFrom) {
        recipient = rcpt[1];
        socket.write('250 2.1.5 recipient accepted\r\n');
        return;
      }
      if (line === 'DATA' && recipient) {
        phase = 'data';
        dataLines = [];
        socket.write('354 end with <CRLF>.<CRLF>\r\n');
        return;
      }
      if (line === 'QUIT') {
        socket.end('221 2.0.0 closing\r\n');
        return;
      }
      socket.write('503 5.5.1 bad sequence\r\n');
    }

    socket.on('data', (chunk) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 32_768) return socket.destroy();
      while (buffer.includes('\r\n')) {
        const index = buffer.indexOf('\r\n');
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        chain = chain.then(() => handleLine(line)).catch(() => socket.destroy());
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    host,
    port: address.port,
    stats,
    close: () => new Promise((resolve, reject) => {
      for (const socket of sockets) socket.destroy();
      server.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}

export async function readOracleLedger(path) {
  try {
    const contents = await readFile(path, 'utf8');
    return contents.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}
