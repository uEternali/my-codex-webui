import { expect, test } from 'bun:test';
import { bridgeRequestTimeout, postBridgeJson, waitForRpcResponse } from '../public/bridge-rpc.js';

function clock() {
  const tasks = new Set<() => void>();
  return { tasks, schedule(callback) { tasks.add(callback); return callback; }, cancel(callback) { tasks.delete(callback); }, tick() { for (const callback of [...tasks]) callback(); } };
}

test('lost WebSocket responses expire, clear pending state and never resend a mutation', async () => {
  const pending = new Map(), timer = clock(); let sends = 0, timeouts = 0;
  const result = waitForRpcResponse(pending, 1, () => { sends++; }, { method: 'turn/start', ...timer, onTimeout() { timeouts++; } });
  const late = pending.get(1), outcome = result.catch(error => error);
  timer.tick(); expect(await outcome).toMatchObject({ code: 'BRIDGE_REQUEST_TIMEOUT' });
  late.resolve({ turn: { id: 'completed-late' } }); timer.tick();
  expect(pending.size).toBe(0); expect(timer.tasks.size).toBe(0);
  expect(sends).toBe(1); expect(timeouts).toBe(1);
  const next = waitForRpcResponse(pending, 2, () => {}, { method: 'thread/read', ...timer });
  const response = pending.get(2); pending.delete(2); response.resolve('recovered');
  expect(await next).toBe('recovered'); expect(timer.tasks.size).toBe(0);
  expect(bridgeRequestTimeout('thread/read')).toBeLessThan(bridgeRequestTimeout('thread/fork'));
});

test('RPC errors and synchronous send failures release their deadline timers', async () => {
  const pending = new Map(), timer = clock();
  const result = waitForRpcResponse(pending, 1, () => { throw new Error('closed'); }, { method: 'thread/read', ...timer });
  await expect(result).rejects.toThrow('closed');
  expect(pending.size).toBe(0); expect(timer.tasks.size).toBe(0);
  const remote = waitForRpcResponse(pending, 2, () => {}, { ...timer });
  pending.get(2).reject(new Error('HTTP 503'));
  await expect(remote).rejects.toThrow('503'); expect(timer.tasks.size).toBe(0);
});

test('SSE request and JSON-body stalls abort without leaving the caller in flight', async () => {
  for (const bodyStalled of [false, true]) {
    const timer = clock(); let signal, calls = 0;
    const result = postBridgeJson('/api/rpc', { method: 'host/thread/live' }, { ...timer, fetchImpl: async (_, options) => {
      signal = options.signal; calls++;
      if (bodyStalled) return { ok: true, json: () => new Promise(() => {}) };
      return new Promise(() => {});
    } });
    const outcome = result.catch(error => error);
    timer.tick(); expect(await outcome).toMatchObject({ code: 'BRIDGE_REQUEST_TIMEOUT' });
    expect(signal.aborted).toBe(true); expect(calls).toBe(1); expect(timer.tasks.size).toBe(0);
  }
  const timer = clock();
  const value = await postBridgeJson('/api/rpc', {}, { ...timer, fetchImpl: async () => ({ ok: true, json: async () => ({ result: 42 }) }) });
  expect(value.data.result).toBe(42); expect(timer.tasks.size).toBe(0);
});
