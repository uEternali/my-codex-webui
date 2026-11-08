#!/usr/bin/env bun
// Controlled app-server fixture: no model requests and no executed commands.
import { createInterface } from 'node:readline';
import { appendFileSync, readFileSync } from 'node:fs';
const threads = new Map();
let sequence = 0, offset = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const log = value => appendFileSync(process.env.STEERING_FIXTURE_LOG, JSON.stringify(value) + '\n');
const add = (thread, item) => {
  const turn = thread.turns.at(-1); turn.items.push(item);
  notify('item/completed', { threadId: thread.id, turnId: turn.id, item });
};
function consume(thread, count = 1) {
  while (count-- > 0 && thread.pending.length) {
    const p = thread.pending.shift();
    add(thread, { id: `item-user-${++sequence}`, type: 'userMessage', clientId: p.clientUserMessageId, content: p.input });
    add(thread, { id: `item-reply-${++sequence}`, type: 'agentMessage', phase: 'commentary', text: `Reply to: ${p.input.filter(x => x.type === 'text').map(x => x.text).join('\n')}` });
  }
}
setInterval(() => {
  const lines = readFileSync(process.env.STEERING_FIXTURE_CONTROL, 'utf8').trim().split('\n').filter(Boolean);
  for (const raw of lines.slice(offset)) {
    const command = JSON.parse(raw), thread = threads.get(command.threadId);
    if (command.type === 'consume') consume(thread, command.count);
    if (command.type === 'commit-on-interrupt') thread.commitOnInterrupt = true;
    if (command.type === 'item') add(thread, command.item);
  }
  offset = lines.length;
}, 25);
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params || {}, method = message.method;
  if (!method) return;
  log(message);
  const reply = result => send({ id: message.id, result });
  const fail = text => send({ id: message.id, error: { code: -32602, message: text } });
  if (method === 'initialize') return reply({ codexHome: process.env.CODEX_HOME });
  if (method === 'initialized') return;
  if (method === 'model/list') return reply({ data: [{ id: 'fixture', model: 'fixture', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] }] });
  if (method === 'permissionProfile/list') return reply({ data: [] });
  if (method === 'account/read') return reply({ account: null });
  if (method === 'thread/list') return reply({ data: [...threads.values()] });
  if (method === 'thread/start') {
    const thread = { id: `thread-${++sequence}`, name: 'Steering fixture', cwd: p.cwd, source: 'local', canAcceptDirectInput: true, status: { type: 'idle' }, turns: [], pending: [] };
    threads.set(thread.id, thread); return reply({ thread });
  }
  const thread = threads.get(p.threadId);
  if (method === 'thread/read' || method === 'thread/resume') return reply({ thread });
  if (method === 'thread/goal/get') return reply({ goal: null });
  if (method === 'thread/turns/list') return reply({ data: [...(thread?.turns || [])].reverse() });
  if (method === 'turn/start') {
    if (thread.status.type === 'active') return fail('Previous turn has not finished');
    const turn = { id: `turn-${++sequence}`, status: 'inProgress', items: [] };
    thread.turns.push(turn); thread.status = { type: 'active' };
    notify('turn/started', { threadId: thread.id, turn });
    add(thread, { id: `item-user-${++sequence}`, clientId: p.clientUserMessageId, type: 'userMessage', content: p.input });
    add(thread, { id: `item-reply-${++sequence}`, type: 'agentMessage', phase: 'commentary', text: thread.turns.length === 1 ? 'First reply before guidance.' : 'Resumed after interruption.' });
    add(thread, { id: `tool-${++sequence}`, type: 'commandExecution', status: 'inProgress', command: 'fixture waiting' });
    return reply({ turn });
  }
  if (method === 'turn/steer') {
    const turn = thread.turns.at(-1);
    if (turn?.id !== p.expectedTurnId || turn.status !== 'inProgress') return fail('No matching active turn');
    thread.pending.push(p);
    return reply({ turnId: turn.id }); // Admission is intentionally separate from consumption.
  }
  if (method === 'turn/interrupt') {
    const turn = thread.turns.at(-1); reply({});
    setTimeout(() => {
      if (thread.commitOnInterrupt) { consume(thread); thread.commitOnInterrupt = false; }
      thread.pending = []; turn.status = 'interrupted'; thread.status = { type: 'idle' };
      notify('turn/completed', { threadId: thread.id, turn });
      log({ event: 'interruption-completed', threadId: thread.id, turnId: turn.id });
    }, 150);
    return;
  }
  reply({ data: [] });
});
