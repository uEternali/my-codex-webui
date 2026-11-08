import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { readJsonBody } from '../http-body.js';

test('reads UTF-8 JSON across byte boundaries and allows an empty body', async () => {
  const req = new PassThrough(), result = readJsonBody(req);
  const bytes = Buffer.from('{"text":"中文"}');
  for (const byte of bytes) req.write(Buffer.from([byte]));
  req.end(); expect(await result).toEqual({ text: '中文' });
  const empty = new PassThrough(), value = readJsonBody(empty); empty.end(); expect(await value).toEqual({});
});

test('rejects oversize JSON promptly without destroying the HTTP stream', async () => {
  const req = new PassThrough(), result = readJsonBody(req, 8);
  req.write('123456789');
  await expect(result).rejects.toThrow('Bridge payload too large');
  expect(req.destroyed).toBe(false); req.end();
});

test('rejects invalid JSON and interrupted clients', async () => {
  const req = new PassThrough(), result = readJsonBody(req); req.end('{');
  await expect(result).rejects.toThrow('Invalid JSON payload');
  const aborted = new PassThrough(), pending = readJsonBody(aborted);
  aborted.emit('aborted'); aborted.emit('error', new Error('socket closed'));
  await expect(pending).rejects.toThrow('Request interrupted'); aborted.end();
});
