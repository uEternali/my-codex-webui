import { describe, expect, test } from 'bun:test';
import { isApprovalRequest, PendingRequestStore } from '../public/approval-state.js';

const approval = (id: number, threadId = 'thread-a', turnId = 'turn-a', itemId = 'command-a') => ({ id, method: 'item/commandExecution/requestApproval', params: { threadId, turnId, itemId, command: 'echo fixture' } });

describe('pending server approvals', () => {
  test('keeps original requests until explicitly resolved and replaces reconnect snapshots', () => {
    const store = new PendingRequestStore(), request = approval(1);
    store.record(request); store.record(request);
    expect(store.snapshot()).toEqual([request]);
    const reconnect = new PendingRequestStore(); reconnect.replace(store.snapshot());
    expect(reconnect.snapshot()).toEqual([request]);
    expect(store.resolve(1)).toBe(true);
    expect(store.resolve(1)).toBe(false);
    reconnect.replace(store.snapshot());
    expect(reconnect.snapshot()).toEqual([]);
  });

  test('resolving or completing one item preserves other pending approvals', () => {
    const store = new PendingRequestStore();
    store.record(approval(1)); store.record(approval(2, 'thread-a', 'turn-a', 'command-b')); store.record(approval(3, 'thread-b'));
    expect(store.handleNotification({ method: 'serverRequest/resolved', params: { threadId: 'thread-a', requestId: 1 } })).toBe(true);
    store.handleNotification({ method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-a', item: { id: 'command-b' } } });
    expect(store.snapshot().map(request => request.id)).toEqual([3]);
  });

  test('turn interruption, thread closure and backend exit discard stale callbacks', () => {
    const store = new PendingRequestStore();
    store.record(approval(1)); store.record(approval(2, 'thread-a', 'turn-b')); store.record(approval(3, 'thread-b'));
    store.handleNotification({ method: 'turn/completed', params: { threadId: 'thread-a', turn: { id: 'turn-a', status: 'interrupted' } } });
    expect(store.snapshot().map(request => request.id)).toEqual([2, 3]);
    store.handleNotification({ method: 'thread/closed', params: { threadId: 'thread-a' } });
    expect(store.snapshot().map(request => request.id)).toEqual([3]);
    store.clear(); expect(store.snapshot()).toEqual([]);
  });

  test('ignores incomplete completion events and recognizes every supported approval kind', () => {
    const store = new PendingRequestStore(); store.record(approval(1));
    expect(store.handleNotification({ method: 'turn/completed', params: {} })).toBe(false);
    expect(store.handleNotification({ method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn-a' } })).toBe(false);
    expect(store.has(1)).toBe(true);
    for (const kind of ['commandExecution', 'fileChange', 'permissions']) expect(isApprovalRequest({ method: `item/${kind}/requestApproval` })).toBe(true);
    expect(isApprovalRequest({ method: 'unknown/request' })).toBe(false);
  });
});
