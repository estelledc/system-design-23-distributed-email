import net from 'node:net';

class LineReader {
  constructor(socket) {
    this.socket = socket;
    this.buffer = '';
    this.lines = [];
    this.waiters = [];
    this.ended = false;
    this.error = null;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => this.push(chunk));
    socket.on('error', (error) => this.finish(error));
    socket.on('close', () => this.finish(new Error('SMTP connection closed')));
  }

  push(chunk) {
    this.buffer += chunk;
    if (Buffer.byteLength(this.buffer) > 32_768) return this.finish(new Error('SMTP response exceeded limit'));
    while (this.buffer.includes('\r\n')) {
      const index = this.buffer.indexOf('\r\n');
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 2);
      if (Buffer.byteLength(line) > 1_000) return this.finish(new Error('SMTP reply line exceeded limit'));
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }

  finish(error) {
    if (this.ended) return;
    this.ended = true;
    this.error = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  nextLine(timeoutMs) {
    if (this.lines.length) return Promise.resolve(this.lines.shift());
    if (this.ended) return Promise.reject(this.error ?? new Error('SMTP connection ended'));
    return new Promise((resolve, reject) => {
      const waiter = {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('SMTP reply timeout'));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }
}

async function readReply(reader, timeoutMs) {
  const first = await reader.nextLine(timeoutMs);
  const match = /^(\d{3})([ -])(.*)$/.exec(first);
  if (!match) throw new Error('malformed SMTP reply');
  const code = Number(match[1]);
  const texts = [match[3]];
  if (match[2] === '-') {
    while (true) {
      const line = await reader.nextLine(timeoutMs);
      const next = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!next || Number(next[1]) !== code) throw new Error('malformed SMTP multiline reply');
      texts.push(next[3]);
      if (next[2] === ' ') break;
    }
  }
  const enhanced = texts.join(' ').match(/\b([245]\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? null;
  return { code, enhancedStatus: enhanced };
}

function baseResult() {
  return {
    lastStage: 'connect',
    dataBytesSent: false,
    uncertain: false,
    networkFailure: false,
    greetingCode: null,
    ehloCode: null,
    mailCode: null,
    rcptCode: null,
    dataCode: null,
    finalCode: null,
    enhancedStatus: null,
  };
}

function replyClass(code) {
  return Math.floor(code / 100);
}

function dotStuff(content) {
  const normalized = content.endsWith('\r\n') ? content : `${content}\r\n`;
  return normalized.replace(/(^|\r\n)\./g, '$1..');
}

export async function sendSmtpMessage({
  host = '127.0.0.1',
  port,
  envelopeFrom,
  envelopeTo,
  canonicalContent,
  timeoutMs = 2_000,
}) {
  if (host !== '127.0.0.1') throw new Error('v0.1 SMTP client permits loopback only');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('SMTP port is invalid');
  const evidence = baseResult();
  const socket = net.createConnection({ host, port });
  socket.setNoDelay(true);
  const reader = new LineReader(socket);
  let stage = 'connect';
  try {
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    stage = 'greeting';
    let reply = await readReply(reader, timeoutMs);
    evidence.lastStage = stage;
    evidence.greetingCode = reply.code;
    evidence.enhancedStatus = reply.enhancedStatus;
    if (replyClass(reply.code) !== 2) return evidence;

    stage = 'ehlo';
    socket.write('EHLO lab.invalid\r\n');
    reply = await readReply(reader, timeoutMs);
    evidence.lastStage = stage;
    evidence.ehloCode = reply.code;
    evidence.enhancedStatus = reply.enhancedStatus;
    if (replyClass(reply.code) !== 2) return evidence;

    stage = 'mail';
    socket.write(`MAIL FROM:<${envelopeFrom}>\r\n`);
    reply = await readReply(reader, timeoutMs);
    evidence.lastStage = stage;
    evidence.mailCode = reply.code;
    evidence.enhancedStatus = reply.enhancedStatus;
    if (replyClass(reply.code) !== 2) return evidence;

    stage = 'rcpt';
    socket.write(`RCPT TO:<${envelopeTo}>\r\n`);
    reply = await readReply(reader, timeoutMs);
    evidence.lastStage = stage;
    evidence.rcptCode = reply.code;
    evidence.enhancedStatus = reply.enhancedStatus;
    if (replyClass(reply.code) !== 2) return evidence;

    stage = 'data';
    socket.write('DATA\r\n');
    reply = await readReply(reader, timeoutMs);
    evidence.lastStage = stage;
    evidence.dataCode = reply.code;
    evidence.enhancedStatus = reply.enhancedStatus;
    if (reply.code !== 354) return evidence;

    stage = 'final';
    socket.write(`${dotStuff(canonicalContent)}.\r\n`);
    evidence.dataBytesSent = true;
    evidence.lastStage = stage;
    reply = await readReply(reader, timeoutMs);
    evidence.finalCode = reply.code;
    evidence.enhancedStatus = reply.enhancedStatus;
    if (!socket.destroyed) socket.write('QUIT\r\n');
    return evidence;
  } catch {
    evidence.lastStage = stage;
    evidence.networkFailure = true;
    evidence.uncertain = evidence.dataBytesSent;
    return evidence;
  } finally {
    socket.destroy();
  }
}
