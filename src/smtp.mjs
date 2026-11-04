import { connect } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { createInterface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { require } from './util.mjs';

export async function sendSmtp(config, message) {
  require(config.host && config.port, 503, 'smtp_configuration', 'SMTP host/port are required');
  require(message.to && message.subject && message.text, 422, 'smtp_message', 'Recipient, subject and text are required');
  const socket = config.secure === false ? connect({ host: config.host, port: config.port }) : connectTls({ host: config.host, port: config.port, servername: config.host });
  socket.setTimeout(config.timeoutMs || 30000);
  const lines = createInterface({ input: socket, crlfDelay: Infinity })[Symbol.asyncIterator]();
  async function response() {
    const received = [];
    while (true) {
      const { value, done } = await lines.next();
      if (done) throw new Error('SMTP connection closed before response');
      received.push(value);
      if (/^\d{3} /.test(value)) {
        const code = Number(value.slice(0, 3));
        return { code, text: received.join('\n') };
      }
    }
  }
  const write = (line) => new Promise((resolve, reject) => socket.write(`${line}\r\n`, 'utf8', (error) => error ? reject(error) : resolve()));
  async function command(line, expected) {
    if (line !== null) await write(line);
    const answer = await response();
    if (!expected.includes(answer.code)) throw new Error(`SMTP ${answer.text.slice(0, 500)}`);
    return answer;
  }
  try {
    await command(null, [220]);
    await command(`EHLO ${config.hostname || 'localhost'}`, [250]);
    if (config.username) {
      await command('AUTH LOGIN', [334]);
      await command(Buffer.from(config.username).toString('base64'), [334]);
      await command(Buffer.from(config.password || '').toString('base64'), [235]);
    }
    await command(`MAIL FROM:<${config.from || config.username}>`, [250]);
    for (const recipient of (Array.isArray(message.to) ? message.to : [message.to])) await command(`RCPT TO:<${recipient}>`, [250, 251]);
    await command('DATA', [354]);
    const headers = [
      `From: ${config.fromName ? `${encodeWord(config.fromName)} <${config.from || config.username}>` : config.from || config.username}`,
      `To: ${(Array.isArray(message.to) ? message.to : [message.to]).join(', ')}`,
      `Subject: ${encodeWord(message.subject)}`,
      `Date: ${new Date().toUTCString()}`,
      `Message-ID: <${randomBytes(12).toString('hex')}@2aos.local>`,
      'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: 8bit'
    ];
    if (config.unsubscribeUrl) headers.push(`List-Unsubscribe: <${config.unsubscribeUrl}>`, 'List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    const body = message.text.replace(/^\./gm, '..').replace(/\r?\n/g, '\r\n');
    await command(`${headers.join('\r\n')}\r\n\r\n${body}\r\n.`, [250]);
    await command('QUIT', [221]);
    return { provider: 'smtp', accepted: true, to: message.to, subject: message.subject };
  } finally {
    socket.destroy();
  }
}
function encodeWord(value) { return `=?UTF-8?B?${Buffer.from(String(value)).toString('base64')}?=`; }
