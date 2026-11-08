#!/usr/bin/env bun
// Isolated native-goal protocol fixture; it never contacts a model or runs tools.
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const threads = new Map(), goals = new Map();
let sequence = 0;
const send = value => process.stdout.write(JSON.stringify(value) + '\n');
const notify = (method, params) => send({ method, params });
const models = [{ id: 'gpt-fixture', model: 'gpt-fixture', displayName: 'Fixture', isDefault: true, defaultReasoningEffort: 'low', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Low' }] }];
const start = target => {
  const turn = { id: `goal-turn-${++sequence}`, status: 'inProgress', items: [] };
  target.turns.push(turn); target.status = { type: 'active' };
  notify('turn/started', { threadId: target.id, turn });
  notify('thread/status/changed', { threadId: target.id, status: target.status });
};
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line), p = message.params || {}, method = message.method;
  if (!method) return;
  appendFileSync(process.env.GOAL_FIXTURE_LOG, JSON.stringify(message) + '\n');
  const reply = result => send({ id: message.id, result });
  const fail = value => send({ id: message.id, error: { code: -32602, message: value } });
  if (method === 'initialize') return reply({ codexHome: process.env.CODEX_HOME });
  if (method === 'initialized') return;
  if (method === 'model/list') return reply({ data: models });
  if (method === 'permissionProfile/list') return reply({ data: [] });
  if (method === 'account/read') return reply({ account: null, requiresOpenaiAuth: false });
  if (method === 'thread/list') return reply({ data: [...threads.values()] });
  if (method === 'thread/start') {
    const target = { id: `goal-thread-${++sequence}`, name: `Goal task ${sequence}`, cwd: p.cwd, source: 'local', canAcceptDirectInput: true, status: { type: 'idle' }, turns: [] };
    threads.set(target.id, target); return reply({ thread: target });
  }
  const target = threads.get(p.threadId);
  if (method === 'thread/read' || method === 'thread/resume') return reply({ thread: target });
  if (method === 'thread/turns/list') return reply({ data: [...(target?.turns || [])].reverse() });
  if (method === 'thread/goal/get') return reply({ goal: goals.get(p.threadId) || null });
  if (method === 'thread/goal/clear') {
    if (p.origin !== 'user') return fail('Explicit user origin is required');
    const cleared = goals.delete(p.threadId); reply({ cleared }); notify('thread/goal/cleared', { threadId: p.threadId }); return;
  }
  if (method === 'thread/goal/set') {
    if (p.origin !== 'user') return fail('Explicit user origin is required');
    if (p.objective === 'fixture fail') return fail('Upstream goal service returned 503');
    const previous = goals.get(p.threadId);
    if (!target || (!p.objective && !previous)) return fail('No goal set for this task');
    if (p.objective !== undefined && (!p.objective.trim() || p.objective.length > 4000)) return fail('Invalid goal objective');
    const current = { threadId: p.threadId, objective: p.objective ?? previous.objective, status: p.status ?? previous?.status ?? 'active', tokenBudget: previous?.tokenBudget ?? null, tokensUsed: previous?.tokensUsed ?? 0, timeUsedSeconds: previous?.timeUsedSeconds ?? 0, createdAt: previous?.createdAt ?? Date.now() / 1000, updatedAt: Date.now() / 1000 };
    goals.set(p.threadId, current);
    const done = () => {
      reply({ goal: current }); notify('thread/goal/updated', { threadId: p.threadId, turnId: null, goal: current });
      if (current.status === 'active' && target.status.type !== 'active') start(target);
    };
    if (p.objective === 'fixture slow') setTimeout(done, 300); else done();
    return;
  }
  if (method === 'turn/interrupt') {
    const turn = target?.turns.at(-1);
    if (turn) { turn.status = 'interrupted'; target.status = { type: 'idle' }; notify('turn/completed', { threadId: target.id, turn }); }
    const current = goals.get(p.threadId);
    if (current) { current.status = 'paused'; notify('thread/goal/updated', { threadId: target.id, turnId: turn?.id, goal: current }); }
    return reply({});
  }
  if (method === 'turn/start') {
    if (!target) return fail('Thread not found');
    start(target); return reply({ turn: target.turns.at(-1) });
  }
  reply({ data: [] });
});
