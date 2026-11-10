import { describe, expect, test } from 'bun:test';
import { fetchJson } from '../public/fetch-json.js';

describe('bounded startup HTTP requests', () => {
  test('decodes JSON and preserves request options', async () => {
    let options;
    const result = await fetchJson('/api/config', { fetchImpl: async (_, init) => { options = init; return Response.json({ home: '/home/test' }); } });
    expect(result).toEqual({ home: '/home/test' }); expect(options.cache).toBe('no-store');
  });
  test('reports HTTP errors for retry instead of accepting an error as configuration', async () => {
    let error;
    try { await fetchJson('/api/config', { fetchImpl: async () => Response.json({ error: 'Configuration unavailable' }, { status: 503 }) }); } catch (reason) { error = reason; }
    expect(error.message).toBe('Configuration unavailable'); expect(error.status).toBe(503);
  });
  test('aborts stalled headers and does not retry writes', async () => {
    let signal, calls = 0;
    await expect(fetchJson('/api/auth/login', { method: 'POST', timeoutMs: 15, fetchImpl: (_, init) => { signal = init.signal; calls++; return new Promise(() => {}); } })).rejects.toThrow('Request timed out: /api/auth/login');
    expect(signal.aborted).toBe(true); expect(calls).toBe(1);
  });
  test('also bounds a body that never finishes decoding', async () => {
    let signal;
    await expect(fetchJson('/api/config', { timeoutMs: 15, fetchImpl: async (_, init) => { signal = init.signal; return { ok: true, json: () => new Promise(() => {}) }; } })).rejects.toThrow('Request timed out: /api/config');
    expect(signal.aborted).toBe(true);
  });
});
