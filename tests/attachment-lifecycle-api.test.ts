import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';

const root = resolve(import.meta.dir, '..');
let temporary: string, base: string, server: ReturnType<typeof Bun.spawn>;
const control = () => join(temporary, 'control.json');
const rpc = async (method, params = {}) => {
  const response = await fetch(base + '/api/rpc', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 1, method, params }) });
  return response.json();
};
beforeAll(async () => {
  temporary = mkdtempSync(join(tmpdir(), 'webui-attachment-api-'));
  for (const name of ['bin', 'codex', 'workspace']) mkdirSync(join(temporary, name));
  const fixture = join(temporary, 'bin/codex'); writeFileSync(fixture, readFileSync(join(root, 'tests/fixtures/thread-actions-codex.mjs'))); chmodSync(fixture, 0o700);
  writeFileSync(control(), '{}');
  const port = await new Promise<number>(resolvePort => { const probe = createServer(); probe.listen(0, '127.0.0.1', () => { const port = (probe.address() as any).port; probe.close(() => resolvePort(port)); }); });
  base = `http://127.0.0.1:${port}`;
  server = Bun.spawn([process.execPath, 'run', 'server.ts'], { cwd: root, env: { ...process.env,
    PATH: `${join(temporary, 'bin')}:${resolve(process.execPath, '..')}:${process.env.PATH}`, HOST: '127.0.0.1', PORT: String(port),
    CODEX_HOME: join(temporary, 'codex'), CODEX_WEBUI_CWD: join(temporary, 'workspace'), CODEX_WEBUI_UPLOAD_DIR: join(temporary, 'uploads'),
    CODEX_WEBUI_AUTH_STORE: join(temporary, 'auth.json'), CODEX_WEBUI_PASSWORD: '', CODEX_WEBUI_ACCESS_TOKEN: '',
    ACTION_FIXTURE_CONTROL: control(), ACTION_FIXTURE_LOG: join(temporary, 'rpc.jsonl'),
  }, stdout: 'ignore', stderr: 'pipe' });
  const deadline = Date.now() + 10000;
  while (true) { try { if ((await fetch(base + '/api/health').then(r => r.json())).codex) break; } catch {} if (Date.now() > deadline) throw new Error('Fixture failed to start'); await Bun.sleep(30); }
});
afterAll(async () => { if (server) { server.kill(); await server.exited; } if (temporary) rmSync(temporary, { recursive: true, force: true }); });

describe('attachment lifecycle through real HTTP/RPC bridge', () => {
  test('draft removal deletes a completed upload using its request id', async () => {
    const uploadId = randomUUID();
    const response = await fetch(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': 'draft.txt', 'x-upload-id': uploadId }, body: 'draft data' });
    const file = await response.json(); expect(response.status).toBe(201); expect(file.uploadId).toBe(uploadId);
    const removed = await fetch(base + '/api/attachments', { method: 'DELETE', body: JSON.stringify({ uploadId }) });
    expect(await removed.json()).toEqual({ deleted: 1, retained: 0, warning: false }); expect(existsSync(file.path)).toBe(false);
  });
  test('cancellation received before the upload prevents a late POST from creating a file', async () => {
    const uploadId = randomUUID();
    expect((await fetch(base + '/api/attachments', { method: 'DELETE', body: JSON.stringify({ uploadId }) })).status).toBe(200);
    const late = await fetch(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': 'late.txt', 'x-upload-id': uploadId }, body: 'late data' });
    expect(late.status).toBe(409);
  });
  test('cancels a partially streamed upload before the body finishes', async () => {
    const uploadId = randomUUID(); let incoming;
    const completed = new Promise<number>((resolveStatus, reject) => {
      incoming = httpRequest(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': 'streamed.txt', 'x-upload-id': uploadId } }, response => { response.resume(); response.on('end', () => resolveStatus(response.statusCode)); });
      incoming.on('error', reject); incoming.write('initial bytes');
    });
    await Bun.sleep(40);
    const removed = await fetch(base + '/api/attachments', { method: 'DELETE', body: JSON.stringify({ uploadId }) });
    expect((await removed.json()).warning).toBe(false); incoming.end('final bytes'); expect(await completed).toBe(409);
  });
  test('draft removal protects saved-session references and rejects project paths', async () => {
    const file = await fetch(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': 'shared.txt' }, body: 'shared data' }).then(r => r.json());
    const thread = (await rpc('thread/start', {})).result.thread;
    await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `Read ${file.path}` }] });
    await rpc('turn/interrupt', { threadId: thread.id });
    const removed = await fetch(base + '/api/attachments', { method: 'DELETE', body: JSON.stringify({ id: file.id }) });
    expect((await removed.json()).retained).toBe(1); expect(existsSync(file.path)).toBe(true);
    const invalid = await fetch(base + '/api/attachments', { method: 'DELETE', body: JSON.stringify({ id: join(temporary, 'workspace/keep.txt') }) });
    expect(invalid.status).toBe(400);
  });
  test('archives keep files, a failed delete keeps them, permanent deletion removes only the upload', async () => {
    const thread = (await rpc('thread/start', {})).result.thread;
    const response = await fetch(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': encodeURIComponent('example.txt') }, body: 'uploaded content' });
    const file = await response.json(); expect(response.status).toBe(201);
    const important = join(temporary, 'workspace/keep.txt'); writeFileSync(important, 'project file');
    expect((await rpc('turn/start', { threadId: thread.id, input: [{ type: 'localImage', path: file.path }, { type: 'text', text: `Server path: ${important}` }] })).type).toBe('rpc/result');
    await rpc('turn/interrupt', { threadId: thread.id });
    await rpc('thread/archive', { threadId: thread.id }); expect(existsSync(file.path)).toBe(true);
    writeFileSync(control(), JSON.stringify({ delete: 'reject' }));
    expect((await rpc('thread/delete', { threadId: thread.id })).type).toBe('rpc/error'); expect(existsSync(file.path)).toBe(true);
    writeFileSync(control(), '{}');
    const result = await rpc('thread/delete', { threadId: thread.id });
    expect(result.result.attachmentCleanup).toEqual({ deleted: 1, retained: 0, warning: false });
    expect(existsSync(file.path)).toBe(false); expect(readFileSync(important, 'utf8')).toBe('project file');
  });
  test('deleting a source leaves its fork readable and keeps their shared upload until the last fork is deleted', async () => {
    const thread = (await rpc('thread/start', {})).result.thread;
    const file = await fetch(base + '/api/attachments', { method: 'POST', headers: { 'x-file-name': 'fork-shared.txt' }, body: 'inherited data' }).then(r => r.json());
    await rpc('turn/start', { threadId: thread.id, input: [{ type: 'text', text: `Read ${file.path}` }] });
    await rpc('turn/interrupt', { threadId: thread.id });
    const fork = (await rpc('thread/fork', { threadId: thread.id })).result.thread;
    const result = await rpc('thread/delete', { threadId: thread.id });
    expect(result.type).toBe('rpc/result');
    expect(result.result.attachmentCleanup.retained).toBe(1);
    expect((await rpc('thread/read', { threadId: fork.id })).result.thread.id).toBe(fork.id);
    expect(existsSync(file.path)).toBe(true);
    expect((await rpc('thread/delete', { threadId: fork.id })).result.attachmentCleanup.deleted).toBe(1);
    expect(existsSync(file.path)).toBe(false);
  });
});
