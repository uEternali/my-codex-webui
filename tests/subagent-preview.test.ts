import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createSubagentPreview, renderSubagentTurns } from '../public/subagent-preview.js';

function root() {
  return new JSDOM('<section hidden><strong data-subagent-title></strong><code data-subagent-id></code><button data-subagent-open></button><div data-subagent-notice hidden><span></span><button data-subagent-retry></button></div><button data-subagent-earlier hidden></button><div data-subagent-content></div></section>').window.document.querySelector('section');
}
const settled = async node => { for (let i = 0; i < 100 && node.hasAttribute('aria-busy'); i++) await Bun.sleep(1); expect(node.hasAttribute('aria-busy')).toBe(false); };

test('preview escapes tool output and renders native user, assistant, reasoning and errors', () => {
  const doc = new JSDOM(renderSubagentTurns([{ id: 'turn', items: [
    { type: 'userMessage', content: [{ type: 'text', text: '<script>alert(1)</script>' }] },
    { type: 'agentMessage', text: '**Child result**' },
    { type: 'reasoning', summary: ['A summary'] },
    { type: 'commandExecution', command: 'echo hello', aggregatedOutput: '<img src=x onerror=alert(1)>', status: 'completed' },
    { type: 'fileChange', changes: [{ path: '/project/example.ts', kind: 'update', diff: '@@ -1 +1 @@\n-old\n+<script>patch()</script>' }], status: 'completed' },
  ], error: { message: 'HTTP 503: upstream failed' } }])).window.document;
  expect(doc.querySelector('script,img')).toBeNull();
  expect(doc.querySelector('strong')?.textContent).toBe('Child result');
  expect(doc.body.textContent).toContain('A summary');
  expect(doc.body.textContent).toContain('HTTP 503');
  expect(doc.body.textContent).toContain('+<script>patch()</script>');
  expect(doc.body.textContent).toContain('/project/example.ts');
});

test('loading preview never resumes, writes or changes the selected main chat', async () => {
  const node = root(), calls = []; let owner = 'main';
  const viewer = createSubagentPreview({ root: node, getOwnerId: () => owner, isVisible: () => true, t: x => x, onOpenChat: () => {}, rpc: async (method, params) => {
    calls.push({ method, params });
    if (method === 'thread/read') return { thread: { id: params.threadId } };
    if (method === 'thread/turns/list') return { data: [{ id: 'turn', items: [{ type: 'agentMessage', text: 'Persisted child content' }] }] };
    return { active: false };
  } });
  try {
    viewer.open({ id: 'child', name: 'Curie' }); await settled(node);
    expect(node.textContent).toContain('Persisted child content'); expect(owner).toBe('main');
    expect(calls.map(call => call.method)).toEqual(['thread/read', 'thread/turns/list', 'host/thread/live']);
    owner = 'other'; viewer.syncOwner(); expect(node.hidden).toBe(true); expect(viewer.selected).toBeNull();
  } finally { viewer.close(); }
});

test('late responses from a previous child never repaint the next preview; 503 is visible', async () => {
  const node = root(); let resolve;
  const old = new Promise(done => { resolve = done; });
  const viewer = createSubagentPreview({ root: node, getOwnerId: () => 'main', isVisible: () => true, t: x => x, onOpenChat: () => {}, rpc: (method, params) => {
    if (params.threadId === 'old') return old;
    return Promise.reject(new Error('HTTP 503: child history unavailable'));
  } });
  try {
    viewer.open({ id: 'old' }); viewer.open({ id: 'new' }); await settled(node);
    expect(node.querySelector('[data-subagent-notice]')?.textContent).toContain('HTTP 503');
    resolve({ thread: { id: 'old', name: 'Wrong child' } }); await Bun.sleep(1);
    expect(node.querySelector('[data-subagent-id]')?.textContent).toBe('new');
    expect(node.textContent).not.toContain('Wrong child');
  } finally { viewer.close(); }
});

test('preview merges live output, preserves expanded tools and exhausted history pagination', async () => {
  const node = root(); let finished = false;
  const last = () => ({ id: 'latest', status: finished ? 'completed' : 'inProgress', items: [{ id: 'tool', type: 'commandExecution', command: 'echo result', status: 'inProgress', aggregatedOutput: finished ? 'finished' : 'started' }] });
  const viewer = createSubagentPreview({ root: node, getOwnerId: () => 'main', isVisible: () => true, t: x => x, onOpenChat: () => {}, rpc: async (method, params) => {
    if (method === 'thread/read') return { thread: { id: 'child' } };
    if (method === 'thread/turns/list') return params.cursor ? { data: [{ id: 'older', items: [{ type: 'agentMessage', text: 'Earlier answer' }] }] } : { data: [last()], nextCursor: 'older' };
    return finished ? { active: false } : { active: true, turn: { ...last(), items: [...last().items, { id: 'live', type: 'agentMessage', text: 'Live child response' }] } };
  } });
  try {
    viewer.open({ id: 'child' }); await settled(node);
    expect(node.textContent).toContain('Live child response');
    node.querySelector('details').open = true;
    await viewer.refresh(true); expect(node.textContent).toContain('Earlier answer');
    expect(node.querySelector('[data-subagent-earlier]')?.hidden).toBe(true);
    finished = true; await viewer.refresh();
    expect(node.querySelector('[data-subagent-earlier]')?.hidden).toBe(true);
    expect(node.querySelector('details')?.open).toBe(true);
    expect(node.querySelector('.subagent-activity.active')).toBeNull();
    expect(node.textContent).toContain('finished');
  } finally { viewer.close(); }
});
