#!/usr/bin/env bun
// Isolated protocol fixture: it never executes commands or contacts a model.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';

const threads = new Map();
let sequence = 0, requestId = 1000;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const thread = id => threads.get(id);
const complete = (target, status = 'completed') => {
  const turn = target.turns.at(-1); if (!turn) return;
  turn.status = status; target.status = { type: 'idle' };
  if (target.pendingId) notify('serverRequest/resolved', { threadId: target.id, requestId: target.pendingId });
  delete target.pendingId;
  notify('turn/completed', { threadId: target.id, turn });
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params || {};
  if (!message.method) {
    appendFileSync(process.env.APPROVAL_FIXTURE_LOG, JSON.stringify(message) + '\n');
    const target = [...threads.values()].find(value => value.pendingId === message.id);
    if (target) complete(target);
    return;
  }
  const reply = result => send({ id: message.id, result });
  if (message.method === 'initialize') return reply({ codexHome: process.env.CODEX_HOME });
  if (message.method === 'initialized') return;
  if (message.method === 'model/list') return reply({ data: [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] }] });
  if (message.method === 'permissionProfile/list') return reply({ data: [] });
  if (message.method === 'account/read') return reply({ account: null, requiresOpenaiAuth: false });
  if (message.method === 'thread/list') return reply({ data: [...threads.values()] });
  if (message.method === 'thread/start') {
    const target = { id: `fixture-thread-${++sequence}`, name: 'Approval reload fixture', cwd: p.cwd, source: 'local', canAcceptDirectInput: true, status: { type: 'idle' }, turns: [] };
    threads.set(target.id, target); return reply({ thread: target });
  }
  if (message.method === 'thread/read' || message.method === 'thread/resume') return reply({ thread: thread(p.threadId) });
  if (message.method === 'thread/turns/list') return reply({ data: thread(p.threadId)?.turns || [] });
  if (message.method === 'turn/start') {
    const target = thread(p.threadId), kind = p.input?.[0]?.text?.includes('permissions') ? 'permissions' : p.input?.[0]?.text?.includes('fileChange') ? 'fileChange' : 'commandExecution';
    const turn = { id: `fixture-turn-${++sequence}`, status: 'inProgress', items: [{ id: `fixture-user-${sequence}`, type: 'userMessage', content: p.input }] };
    const item = { id: `fixture-item-${sequence}`, type: kind, status: 'inProgress', command: 'echo approval-fixture', changes: [] };
    turn.items.push(item); target.turns.push(turn); target.status = { type: 'active' };
    target.pendingId = ++requestId;
    reply({ turn });
    notify('turn/started', { threadId: target.id, turn });
    notify('item/started', { threadId: target.id, turnId: turn.id, item });
    send({ id: target.pendingId, method: `item/${kind}/requestApproval`, params: { threadId: target.id, turnId: turn.id, itemId: item.id, cwd: target.cwd, command: item.command, reason: 'Approval persistence test; no command will run.', startedAtMs: Date.now(), permissions: { network: { enabled: true } } } });
    return;
  }
  if (message.method === 'turn/interrupt') { complete(thread(p.threadId), 'interrupted'); return reply({}); }
  reply({ data: [] });
});
