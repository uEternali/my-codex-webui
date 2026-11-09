import { expect, test } from 'bun:test';
import { SideChatService } from '../side-chat-service.js';
import { parseSideCommand } from '../public/side-chat.js';
import { SideChatTranscript } from '../public/side-chat-state.js';

const key = 'side-chat-test-123456';
function fixture() {
  const calls: any[] = [], turns: any[] = [];
  let service: SideChatService, time = 0, failure: string | null = null;
  const request = async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === failure) throw new Error('HTTP 503');
    if (method === 'thread/start' || method === 'thread/fork') return { thread: { id: 'ephemeral-side', ephemeral: true, path: null, turns: [{ id: 'inherited-turn' }] } };
    if (method === 'thread/turns/list') return { data: [...turns].reverse() };
    if (method === 'turn/start') {
      const turn = { id: 'side-turn', status: 'inProgress', items: [{ type: 'userMessage', content: params.input }] }; turns.push(turn);
      service.notification('turn/started', { threadId: 'ephemeral-side', turn }); return { turn };
    }
    if (method === 'turn/interrupt') service.notification('turn/completed', { threadId: params.threadId, turn: { id: params.turnId, status: 'interrupted' } });
    return {};
  };
  service = new SideChatService({ request, now: () => time, ttl: 100 });
  return { service, calls, turns, advance: () => { time += 101; }, fail: (method: string | null) => { failure = method; } };
}

test('side command is explicit, accepts questions and never consumes ordinary prose', () => {
  expect(parseSideCommand('/side')).toEqual({ prompt: '' });
  expect(parseSideCommand('side')).toEqual({ prompt: '' });
  expect(parseSideCommand('/side Why this change?\nPlease explain.')).toEqual({ prompt: 'Why this change?\nPlease explain.' });
  for (const text of ['outside', 'side effects', '/sidebar', 'Use /side here']) expect(parseSideCommand(text)).toBeNull();
});

test('side uses the native ephemeral context fork and never creates a saved branch', async () => {
  const { service, calls } = fixture();
  const [one, two] = await Promise.all([service.start({ key, parentThreadId: 'main-working' }), service.start({ key, parentThreadId: 'main-working' })]);
  expect(one).toEqual(two); expect(one.thread.turns).toEqual([]);
  expect(calls).toHaveLength(1);
  expect(calls[0].method).toBe('thread/fork');
  expect(calls[0].params).toMatchObject({ threadId: 'main-working', ephemeral: true, excludeTurns: true, config: { thread_unload_delay_secs: 0 } });
  await expect(service.start({ key, parentThreadId: 'different-main' })).rejects.toThrow('context has changed');
});

test('a blank page starts an ephemeral conversation in its workspace', async () => {
  const { service, calls } = fixture();
  await service.start({ key, cwd: '/workspace', model: 'test' });
  expect(calls[0]).toMatchObject({ method: 'thread/start', params: { ephemeral: true, cwd: '/workspace', model: 'test' } });
});

test('read hides inherited history and only the side chat is interrupted and released', async () => {
  const { service, calls, turns } = fixture();
  await service.start({ key, parentThreadId: 'main-working' });
  turns.push({ id: 'inherited-turn' });
  await service.send({ key, text: 'Side question' });
  expect((await service.read({ key })).turns.map(turn => turn.id)).toEqual(['side-turn']);
  expect(calls.some(call => call.method === 'thread/turns/list')).toBe(false);
  await expect(service.send({ key, text: 'Second' })).rejects.toThrow('already working');
  await service.close({ key }); await service.close({ key });
  expect(calls.filter(call => call.method === 'turn/interrupt')).toEqual([{ method: 'turn/interrupt', params: { threadId: 'ephemeral-side', turnId: 'side-turn' } }]);
  expect(calls.filter(call => call.method === 'thread/unsubscribe')).toHaveLength(1);
  expect(calls.some(call => call.method === 'thread/delete' || call.method === 'thread/name/set')).toBe(false);
  await expect(service.start({ key, parentThreadId: 'main-working' })).rejects.toThrow('closed');
});

test('streamed side history restores after reconnect and late snapshots cannot restart a finished turn', () => {
  const transcript = new SideChatTranscript();
  transcript.notification('turn/started', { turn: { id: 'turn-1', items: [{ id: 'user-1', type: 'userMessage', content: [{ type: 'text', text: 'Question' }] }] } });
  transcript.notification('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'answer-1', delta: 'First ' });
  transcript.notification('item/agentMessage/delta', { turnId: 'turn-1', itemId: 'answer-1', delta: 'answer' });
  transcript.notification('error', { turnId: 'turn-1', willRetry: true, error: { message: 'Reconnecting 1/5 HTTP 503' } });
  expect(transcript.activeTurnId).toBe('turn-1');
  const restored = new SideChatTranscript(); restored.load(structuredClone(transcript.snapshot()));
  expect(restored.snapshot()).toEqual(transcript.snapshot());
  restored.notification('turn/completed', { turn: { id: 'turn-1', status: 'completed', items: [] } });
  restored.mergeTurn({ id: 'turn-1', status: 'inProgress', items: [] });
  expect(restored.activeTurnId).toBeNull();
  expect(restored.snapshot().turns[0].items[1].text).toBe('First answer');
  expect(restored.snapshot().turns[0].items).toHaveLength(2);
});

test('close racing native creation waits and releases the eventual ephemeral thread', async () => {
  let release: (value: any) => void;
  const calls: string[] = [];
  const service = new SideChatService({ request: async method => {
    calls.push(method);
    if (method === 'thread/fork') return new Promise(resolve => { release = resolve; });
    return {};
  } });
  const starting = service.start({ key, parentThreadId: 'main' }), closing = service.close({ key });
  release!({ thread: { id: 'late-side', ephemeral: true, path: null } });
  await Promise.all([starting, closing]);
  expect(calls).toEqual(['thread/fork', 'thread/unsubscribe']); expect(service.entries.size).toBe(0);
});

test('failed release is retryable and stale browser leases release abandoned side chats', async () => {
  const { service, calls, fail, advance } = fixture();
  await service.start({ key }); fail('thread/unsubscribe');
  await expect(service.close({ key })).rejects.toThrow('503'); expect(service.entries.size).toBe(1);
  fail(null); advance(); await service.sweep(); expect(service.entries.size).toBe(0);
  expect(calls.filter(call => call.method === 'thread/unsubscribe')).toHaveLength(2);
  await service.close({ key: 'close-before-start-1234' });
  await expect(service.start({ key: 'close-before-start-1234' })).rejects.toThrow('closed');
});

test('untrusted side requests cannot address arbitrary native lifecycle methods', async () => {
  const { service, calls } = fixture();
  await expect(service.start({ key: '../saved-thread' })).rejects.toThrow('Invalid');
  await expect(service.close({ key: 'main' })).rejects.toThrow('Invalid');
  await expect(service.send({ key, text: 'Hello' })).rejects.toThrow('no longer available');
  expect(calls).toHaveLength(0);
});
