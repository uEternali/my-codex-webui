import { describe, expect, test } from 'bun:test';
import { createThreadTurnReader } from '../public/thread-sync.js';

describe('conditional conversation synchronization', () => {
  test('unchanged active and idle conversations avoid native full-history reads', async () => {
    const calls: any[] = [], turn = { id: 't', status: 'inProgress', items: [] };
    let revision = 'r1', active = true;
    const reader = createThreadTurnReader(async (method, params) => {
      calls.push({ method, params });
      if (method === 'host/thread/live') return params.sinceRevision === revision
        ? { revision, active, unchanged: true } : { revision, active, turn: active ? turn : null };
      return { data: [{ ...turn, status: 'completed' }] };
    });
    expect((await reader.read('a', { conditional: true })).turn).toBe(turn);
    expect((await reader.read('a', { conditional: true })).unchanged).toBe(true);
    expect(calls.map(c => c.method)).toEqual(['host/thread/live', 'host/thread/live']);
    revision = 'r2'; active = false;
    expect((await reader.read('a', { conditional: true })).turn.status).toBe('completed');
    expect((await reader.read('a', { conditional: true })).unchanged).toBe(true);
    expect(calls.filter(c => c.method === 'thread/turns/list')).toHaveLength(1);
    await reader.read('a');
    expect(calls.at(-2).params).toEqual({ threadId: 'a' });
    expect(calls.filter(c => c.method === 'thread/turns/list')).toHaveLength(2);
  });

  test('navigation, reconnect and a late old response cannot reuse the previous revision', async () => {
    const calls: any[] = []; let release;
    const reader = createThreadTurnReader(async (method, params) => {
      calls.push({ method, params });
      if (params.threadId === 'old') return new Promise(resolve => { release = resolve; });
      return { revision: 'new-revision', active: true, turn: { id: 'new-turn' } };
    });
    const old = reader.read('old', { conditional: true }); reader.reset();
    await reader.read('new', { conditional: true });
    release({ revision: 'old-revision', active: true, turn: { id: 'old-turn' } }); await old;
    await reader.read('new', { conditional: true });
    expect(calls.at(-1).params.sinceRevision).toBe('new-revision');
    reader.reset(); await reader.read('new', { conditional: true });
    expect(calls.at(-1).params).toEqual({ threadId: 'new' });
  });

  test('supports older bridges and native API fallback without caching failed reads', async () => {
    let versioned = false, fail = false; const calls: any[] = [];
    const reader = createThreadTurnReader(async (method, params) => {
      calls.push({ method, params });
      if (method === 'host/thread/live') return versioned ? { active: false, revision: 'r' } : { active: false };
      if (method === 'thread/turns/list') throw new Error('unsupported');
      if (fail) throw new Error('HTTP 503');
      return { thread: { turns: [{ id: 'native' }] } };
    });
    expect((await reader.read('a', { conditional: true })).turn.id).toBe('native');
    await reader.read('a', { conditional: true });
    expect(calls[3].params).toEqual({ threadId: 'a' });
    versioned = true; fail = true;
    await expect(reader.read('a', { conditional: true })).rejects.toThrow('503');
    fail = false; await reader.read('a', { conditional: true });
    expect(calls.at(-3).params).toEqual({ threadId: 'a' });
  });

  test('transport failures do not cascade into additional expensive reads', async () => {
    for (const error of [Object.assign(new Error('timeout'), { code: 'BRIDGE_REQUEST_TIMEOUT' }), Object.assign(new Error('switch'), { silentTransportSwitch: true })]) {
      const calls: string[] = [];
      const reader = createThreadTurnReader(async method => { calls.push(method); throw error; });
      await expect(reader.read('a', { conditional: true })).rejects.toBe(error);
      expect(calls).toEqual(['host/thread/live']);
    }
  });
});
