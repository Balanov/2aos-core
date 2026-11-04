import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { sendSmtp } from '../src/smtp.mjs';
import { fixture, install } from './helpers.mjs';

test('SMTP client completes multiline EHLO, AUTH and DATA exchange', async (t) => {
  let received = '';
  const server = createServer((socket) => {
    socket.write('220 localhost ESMTP test\r\n');
    let buffer = '', dataMode = false, authStep = 0;
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      if (dataMode) {
        const end = buffer.indexOf('\r\n.\r\n');
        if (end < 0) return;
        received += buffer.slice(0, end);
        buffer = buffer.slice(end + 5); dataMode = false;
        socket.write('250 2.0.0 queued\r\n');
      }
      while (!dataMode) {
        const end = buffer.indexOf('\r\n');
        if (end < 0) return;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        if (line.startsWith('EHLO')) socket.write('250-localhost\r\n250-AUTH LOGIN\r\n250 SIZE 1000000\r\n');
        else if (line === 'AUTH LOGIN') { authStep = 1; socket.write('334 VXNlcm5hbWU6\r\n'); }
        else if (authStep === 1) { authStep = 2; socket.write('334 UGFzc3dvcmQ6\r\n'); }
        else if (authStep === 2) { authStep = 0; socket.write('235 Accepted\r\n'); }
        else if (line.startsWith('MAIL FROM') || line.startsWith('RCPT TO')) socket.write('250 OK\r\n');
        else if (line === 'DATA') { dataMode = true; socket.write('354 End data with <CR><LF>.<CR><LF>\r\n'); }
        else if (line === 'QUIT') socket.write('221 Bye\r\n');
        else if (line) socket.write('235 Accepted\r\n');
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const receipt = await sendSmtp({ host: '127.0.0.1', port: server.address().port, secure: false, username: 'user', password: 'pass', from: 'sender@example.com', unsubscribeUrl: 'https://example.com/unsubscribe' }, { to: 'client@example.com', subject: 'Отчёт', text: 'Первая строка\n.точка' });
  assert.equal(receipt.accepted, true);
  assert.match(received, /List-Unsubscribe/);
  assert.match(received, /\.\.точка/);
});

test('approved scheduled content stays pending until due time', async (t) => {
  const runtime = fixture(t);
  await install(runtime, 'content-generation');
  runtime.dispatcher.upsertIntegration({ tenantId: 'tenant_default', kind: 'memory', name: 'telegram', config: {}, actor: 'user_admin' });
  const future = new Date(Date.now() + 3600_000).toISOString();
  runtime.orchestrator.enqueue({ tenantId: 'tenant_default', agentSlug: 'content-generation', payload: { topic: 'Test', channels: ['telegram'], template: '{topic}', schedule: future }, idempotencyKey: 'scheduled-content', actor: 'user_admin' });
  const [job] = await runtime.orchestrator.drain();
  const effect = job.effects[0];
  const approved = await runtime.orchestrator.approve({ tenantId: 'tenant_default', approvalId: effect.approvalId, expectedDigest: effect.digest, actor: 'user_admin' });
  assert.equal(approved.result.scheduled, true);
  assert.equal(runtime.store.get('SELECT status FROM outbox WHERE id=?', effect.outboxId).status, 'pending');
  assert.equal((await runtime.orchestrator.dispatchDueOutbox()).length, 0);
  runtime.store.run('UPDATE outbox SET available_at=? WHERE id=?', new Date(Date.now() - 1000).toISOString(), effect.outboxId);
  const dispatched = await runtime.orchestrator.dispatchDueOutbox();
  assert.equal(dispatched[0].status, 'sent');
  assert.equal(runtime.store.get('SELECT status FROM outbox WHERE id=?', effect.outboxId).status, 'sent');
});
