import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createServer, request } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gunzipSync } from 'node:zlib';
import { createStaticAssetSender } from '../static-assets.js';

let directory: string, base: string, server: ReturnType<typeof createServer>;
const source = 'const message = "Hello Codex";\n'.repeat(300);
const get = (path = '/main.js', headers = {}, method = 'GET') => new Promise<any>((resolve, reject) => {
  const req = request(base + path, { headers, method }, res => {
    const chunks: Buffer[] = [];
    res.on('data', chunk => chunks.push(chunk));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
  });
  req.on('error', reject); req.end();
});
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'webui-static-assets-'));
  writeFileSync(join(directory, 'main.js'), source);
  writeFileSync(join(directory, 'other.js'), source.replaceAll('Codex', 'Other'));
  const send = createStaticAssetSender({ maxEntries: 1, maxBytes: 20_000 });
  server = createServer((req, res) => { void send(req, res, join(directory, req.url === '/other.js' ? 'other.js' : 'main.js'), 'text/javascript; charset=utf-8'); });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
afterAll(async () => { await new Promise<void>(done => server.close(() => done())); rmSync(directory, { recursive: true, force: true }); });

describe('static resource transfer and cache validation', () => {
  test('compresses text once and supports identity and disabled gzip', async () => {
    const zipped = await get('/main.js', { 'accept-encoding': 'gzip' });
    expect(zipped.headers['content-encoding']).toBe('gzip');
    expect(zipped.body.length).toBeLessThan(source.length / 5);
    expect(gunzipSync(zipped.body).toString()).toBe(source);
    expect(Number(zipped.headers['content-length'])).toBe(zipped.body.length);
    const raw = await get('/main.js', { 'accept-encoding': 'gzip;q=0, br' });
    expect(raw.headers['content-encoding']).toBeUndefined(); expect(raw.body.toString()).toBe(source);
    expect(raw.headers.etag).toBe(zipped.headers.etag);
    expect(raw.headers.vary).toBe('Accept-Encoding');
    expect(raw.headers['cache-control']).toBe('private, no-cache');
  });
  test('revalidates cached resources without transferring their bodies', async () => {
    const first = await get();
    const cached = await get('/main.js', { 'if-none-match': `"unrelated", ${first.headers.etag}`, 'accept-encoding': 'gzip' });
    expect(cached.status).toBe(304); expect(cached.body.length).toBe(0);
    expect(cached.headers.etag).toBe(first.headers.etag);
    const head = await get('/main.js', {}, 'HEAD');
    expect(head.status).toBe(200); expect(head.body.length).toBe(0);
    expect(Number(head.headers['content-length'])).toBe(Buffer.byteLength(source));
  });
  test('a deployment invalidates an old ETag, including same-length rewrites', async () => {
    const previous = await get();
    const updated = source.replaceAll('Codex', 'World');
    writeFileSync(join(directory, 'main.js'), updated);
    const next = await get('/main.js', { 'if-none-match': previous.headers.etag, 'accept-encoding': 'gzip' });
    expect(next.status).toBe(200); expect(next.headers.etag).not.toBe(previous.headers.etag);
    expect(gunzipSync(next.body).toString()).toBe(updated);
    // Evict the cached representation, then serve it again without corrupting it.
    await get('/other.js', { 'accept-encoding': 'gzip' });
    expect((await get()).body.toString()).toBe(updated);
  });
});
