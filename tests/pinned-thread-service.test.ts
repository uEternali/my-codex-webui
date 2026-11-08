import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PinnedThreadStore } from '../pinned-thread-service.js';

const roots: string[] = [];
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'webui-pins-')); roots.push(root); return join(root, 'pins.json'); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

test('persists pin/unpin preferences privately and rejects invalid state', () => {
  const path = setup(), store = new PinnedThreadStore(path);
  const result = store.set('old', true);
  expect(result.pinnedAt).toBeGreaterThan(0);
  expect(new PinnedThreadStore(path).pins.get('old')).toBe(result.pinnedAt);
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(store.set('old', true)).toEqual(result);
  store.set('old', false); expect(new PinnedThreadStore(path).pins.size).toBe(0);
  for (const [id, pinned] of [['', true], ['id', 'yes'], [null, false]]) expect(() => store.set(id, pinned)).toThrow('Invalid pin request');
});

test('loads older pinned sessions outside the native first page and keeps every native page row without duplicates', async () => {
  const store = new PinnedThreadStore(setup()); store.set('old', true);
  const result = await store.merge({ data: [{ id: 'new' }, { id: 'next' }], nextCursor: 'page2' }, { limit: 2 }, async id => ({ thread: { id, turns: ['history'] } }));
  expect(result.data.map(thread => thread.id)).toEqual(['old', 'new', 'next']);
  expect(result.data[0].turns).toEqual([]); expect(result.nextCursor).toBe('page2');
  const listed = await store.merge({ data: [{ id: 'old' }, { id: 'new' }] }, {}, async () => { throw Error('Should not read a listed thread'); });
  expect(listed.data.map(thread => thread.id)).toEqual(['old', 'new']);
});

test('respects native filters and archives and clears deleted pins while retaining transient failures', async () => {
  const store = new PinnedThreadStore(setup()); store.set('old', true);
  for (const params of [{ archived: true }, { cwd: '/elsewhere' }, { cursor: 'next' }]) {
    expect((await store.merge({ data: [] }, params, async () => { throw Error('Must not read'); })).data).toEqual([]);
  }
  await store.merge({ data: [] }, {}, async () => { throw Error('HTTP 503'); }); expect(store.pins.has('old')).toBe(true);
  await store.merge({ data: [] }, {}, async () => ({ thread: { id: 'old', path: '/home/me/.codex/archived_sessions/rollout.jsonl' } })); expect(store.pins.size).toBe(0);
  store.set('old', true); await store.merge({ data: [] }, {}, async () => { throw Error('Thread not found'); }); expect(store.pins.size).toBe(0);
});
