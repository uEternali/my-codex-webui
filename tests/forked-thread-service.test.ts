import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ForkedThreadIndex } from '../forked-thread-service.js';

const roots: string[] = [];
const setup = () => { const root = mkdtempSync(join(tmpdir(), 'webui-forks-')); roots.push(root); return join(root, 'forks.json'); };
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const fork = { id: 'fork', forkedFromId: 'parent', ephemeral: false, updatedAt: 20, createdAt: 20, preview: '', turns: [{ items: [{ type: 'userMessage', content: [{ type: 'text', text: 'Original question' }] }] }] };

test('keeps an unlisted fork visible after a new server instance and never copies its history into the index', async () => {
  const path = setup(), index = new ForkedThreadIndex(path);
  expect(index.remember(fork).preview).toBe('Original question');
  expect(statSync(path).mode & 0o777).toBe(0o600);
  const restored = new ForkedThreadIndex(path);
  const result = await restored.merge({ data: [{ id: 'parent', createdAt: 10 }] }, { limit: 50 }, async id => ({ thread: { ...fork, id } }));
  expect(result.data.map(thread => thread.id)).toEqual(['fork', 'parent']);
  expect(result.data[0].preview).toBe('Original question');
  expect(result.data[0].turns).toEqual([]);
});

test('deduplicates materialized native branches, sorts by recency and preserves native pagination and filters', async () => {
  const index = new ForkedThreadIndex(setup()); index.remember(fork);
  const read = async () => ({ thread: fork });
  expect((await index.merge({ data: [{ ...fork, preview: 'New question' }] }, {}, read)).data).toEqual([{ ...fork, preview: 'New question' }]);
  const page = await index.merge({ data: [{ id: 'parent', createdAt: 10, updatedAt: 30 }], nextCursor: 'page2' }, { sortKey: 'recency_at', limit: 1 }, read);
  expect(page.data.map(thread => thread.id)).toEqual(['parent', 'fork']);
  expect(page.nextCursor).toBe('page2');
  for (const params of [{ cursor: 'next' }, { archived: true }, { cwd: '/project' }, { sourceKinds: ['cli'] }]) {
    expect((await index.merge({ data: [] }, params, read)).data).toEqual([]);
  }
});

test('does not register ephemeral forks and removes deleted branches durably', async () => {
  const path = setup(), index = new ForkedThreadIndex(path);
  index.remember({ ...fork, ephemeral: true }); expect(index.entries.size).toBe(0);
  index.remember(fork); index.forget(fork.id);
  expect(new ForkedThreadIndex(path).entries.size).toBe(0);
  index.remember(fork);
  await index.merge({ data: [] }, {}, async () => { throw Error('Thread not found'); });
  expect(new ForkedThreadIndex(path).entries.size).toBe(0);
});

test('retains the registration on transient upstream errors so a later refresh can recover', async () => {
  const index = new ForkedThreadIndex(setup()); index.remember(fork);
  expect((await index.merge({ data: [] }, {}, async () => { throw Error('HTTP 503'); })).data).toEqual([]);
  expect((await index.merge({ data: [] }, {}, async () => ({ thread: fork }))).data[0].id).toBe(fork.id);
});

test('archive and restore survive restarts without resurrecting an empty fork in active chats', async () => {
  const path = setup(), index = new ForkedThreadIndex(path); index.remember(fork);
  const read = async () => ({ thread: fork });
  await index.merge({ data: [] }, {}, read); // Seed active cache first.
  index.setArchived('fork', true);
  const archived = new ForkedThreadIndex(path);
  expect((await archived.merge({ data: [] }, {}, read)).data).toEqual([]);
  expect((await archived.merge({ data: [] }, { archived: true }, read)).data[0].id).toBe('fork');
  archived.setArchived('fork', false);
  expect((await archived.merge({ data: [] }, { archived: true }, read)).data).toEqual([]);
  expect((await new ForkedThreadIndex(path).merge({ data: [] }, {}, read)).data[0].id).toBe('fork');
});

test('invalidates cached branch names immediately after native rename', async () => {
  const index = new ForkedThreadIndex(setup()); index.remember(fork);
  await index.merge({ data: [] }, {}, async () => ({ thread: { ...fork, name: 'Before' } }));
  index.invalidate('fork');
  expect((await index.merge({ data: [] }, {}, async () => ({ thread: { ...fork, name: 'After' } }))).data[0].name).toBe('After');
});
