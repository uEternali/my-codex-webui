import { expect, test } from 'bun:test';
import { createSessionTree, sessionChats, subagentThreads } from '../public/session-tree.js';

const root = { id: 'root', sessionId: 'root' };
const child = { id: 'child', sessionId: 'root', parentThreadId: 'root' };
const nested = { id: 'nested', sessionId: 'root', parentThreadId: 'child' };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('session membership follows native sessionId, including independent saved forks', () => {
  const fork = { id: 'fork', sessionId: 'fork', forkedFromId: 'root' };
  expect(sessionChats(child, [root, child, nested, fork]).map(t => t.id)).toEqual(['child', 'root', 'nested']);
  expect(sessionChats({ id: 'unknown', forkedFromId: 'root' }, [root]).map(t => t.id)).toEqual(['unknown']);
  expect(sessionChats(fork, [root, child]).map(t => t.id)).toEqual(['fork']);
});

test('subagent traversal follows explicit parents and rejects fork ancestry and cycles', () => {
  const data = [nested, child, { id: 'fork', sessionId: 'root', forkedFromId: 'root' }, { id: 'orphan', parentThreadId: 'absent' }, { id: 'cycle-a', parentThreadId: 'cycle-b' }, { id: 'cycle-b', parentThreadId: 'cycle-a' }];
  expect(subagentThreads(data, 'root').map(t => [t.id, t.depth])).toEqual([['child', 1], ['nested', 2]]);
});

test('native children with their own session IDs remain related through explicit parent edges', async () => {
  const nativeChild = { id: 'child', sessionId: 'child', parentThreadId: 'root' };
  const nativeNested = { id: 'nested', sessionId: 'nested', source: { subAgent: { thread_spawn: { parent_thread_id: 'child' } } } };
  const foreign = { id: 'foreign', sessionId: 'foreign', parentThreadId: 'someone-else' };
  expect(sessionChats(root, [root, nativeChild, nativeNested, foreign]).map(t => t.id)).toEqual(['root', 'child', 'nested']);
  const tree = createSessionTree({ rpc: async () => ({ data: [nativeChild, nativeNested, foreign] }) });
  await tree.refresh(root);
  expect(sessionChats(root, tree.snapshot(root).threads).map(t => t.id)).toEqual(['root', 'child', 'nested']);
});

test('related metadata is fetched on demand, paged and cached without resuming a chat', async () => {
  const calls = []; let time = 0;
  const tree = createSessionTree({ now: () => time, rpc: async (method, params) => {
    calls.push({ method, params });
    return params.cursor ? { data: [nested] } : { data: [child], nextCursor: 'page-2' };
  } });
  expect(tree.snapshot(root).threads).toEqual([root]); expect(calls).toHaveLength(0);
  await Promise.all([tree.refresh(root), tree.refresh(root)]);
  expect(calls).toHaveLength(2);
  expect(calls[0].params).toMatchObject({ ancestorThreadId: 'root', modelProviders: [] });
  expect(calls[0].params.sourceKinds).toContain('subAgentThreadSpawn');
  expect(tree.snapshot(root).threads.map(t => t.id).sort()).toEqual(['child', 'nested', 'root']);
  await tree.refresh(root); expect(calls).toHaveLength(2);
  time = 10001; await tree.refresh(root); expect(calls).toHaveLength(4);
  expect(calls.every(call => call.method === 'thread/list')).toBe(true);
});

test('late responses cannot mix families after navigation, including A to B to A', async () => {
  const response = deferred(); let changes = 0;
  const tree = createSessionTree({ rpc: () => response.promise, onChange: () => changes++ });
  const pending = tree.refresh(root); await Promise.resolve();
  tree.snapshot({ id: 'other', sessionId: 'other' }); tree.snapshot(root);
  response.resolve({ data: [child] }); await pending;
  expect(tree.snapshot(root).threads).toEqual([root]); expect(changes).toBe(0);
});

test('list errors remain visible, allow retry, and repeated cursors terminate', async () => {
  let fail = true;
  const tree = createSessionTree({ rpc: () => { if (fail) throw new Error('HTTP 503'); return Promise.resolve({ data: [child], nextCursor: 'repeated' }); } });
  await tree.refresh(root); expect(tree.snapshot(root)).toMatchObject({ loading: false, error: 'HTTP 503' });
  fail = false; await tree.refresh(root, [], true);
  expect(tree.snapshot(root)).toMatchObject({ loading: false, error: 'Could not load all related chats' });
});

test('new children and background status notifications update only the matching tree', async () => {
  const tree = createSessionTree({ rpc: async () => ({ data: [] }) });
  await tree.refresh(root);
  tree.notification('thread/started', { thread: child });
  tree.notification('thread/status/changed', { threadId: 'child', status: { type: 'active' } });
  tree.notification('thread/started', { thread: { id: 'unrelated', sessionId: 'elsewhere' } });
  expect(tree.snapshot(root).threads.find(t => t.id === 'child')?.status.type).toBe('active');
  expect(tree.snapshot(root).threads.some(t => t.id === 'unrelated')).toBe(false);
  tree.notification('thread/deleted', { threadId: 'child' });
  expect(tree.snapshot(root).threads).toEqual([root]);
});

test('refresh removes children deleted outside this browser without inventing a missing root', async () => {
  let data = [child];
  const tree = createSessionTree({ rpc: async () => ({ data }) });
  await tree.refresh(root); expect(tree.snapshot(root).threads).toHaveLength(2);
  data = []; await tree.refresh(root, [], true);
  expect(tree.snapshot(root).threads).toEqual([root]);
});
