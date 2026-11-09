import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { contextUsageValue, renderSessionStatus } from '../public/session-status.js';
import { createI18n } from '../public/i18n.js';

test('context distinguishes missing data from zero, and keeps actual tokens above the window', () => {
  for (const last of [undefined, null, { totalTokens: null }, { totalTokens: -1 }, { totalTokens: NaN }]) {
    expect(contextUsageValue({ modelContextWindow: 100, last })).toBeNull();
  }
  expect(contextUsageValue({ modelContextWindow: 100, last: { totalTokens: 0 } })).toMatchObject({ percent: 0, remainingTokens: 100 });
  expect(contextUsageValue({ modelContextWindow: 100, last: { totalTokens: 120 } })).toMatchObject({ usedTokens: 120, percent: 100, remainingTokens: 0 });
});

test('renders native Session and Chat identifiers with honest unavailable states', () => {
  const html = renderSessionStatus({ thread: { id: 'thread-1', sessionId: 'root-session', status: { type: 'idle' } }, name: '<img src=x onerror=alert(1)>', cwd: '/work/<project>', permission: {} });
  const document = new JSDOM(html).window.document;
  expect([...document.querySelectorAll('[data-status-copy]')].map(node => node.getAttribute('data-status-copy'))).toEqual(['root-session', 'thread-1']);
  expect([...document.querySelectorAll('dt')].slice(0, 4).map(node => node.textContent)).toEqual(['Session', 'Chat', 'Background information', 'Limits']);
  expect(document.querySelector('img')).toBeNull();
  expect(document.body.textContent).toContain('<img src=x onerror=alert(1)>');
  expect(document.querySelector('[role=progressbar]')).toBeNull();
  expect(document.body.textContent).toContain('Token usage has not been reported');
  const blank = new JSDOM(renderSessionStatus({ permission: {} })).window.document;
  expect(blank.querySelectorAll('[data-status-copy]')).toHaveLength(0);
  expect(blank.body.textContent).not.toContain('Session ID');
  const unknown = new JSDOM(renderSessionStatus({ thread: { id: 'unknown-session' } })).window.document;
  expect([...unknown.querySelectorAll('[data-status-copy]')].map(node => node.getAttribute('data-status-copy'))).toEqual(['unknown-session']);
});

test('only expands verified members of the current session and keeps the selected chat first', () => {
  const thread = { id: 'child', sessionId: 'root' };
  const relatedThreads = [thread, { id: 'root', sessionId: 'root' }, { id: 'nested', sessionId: 'root' }, { id: 'separate-fork', sessionId: 'separate-fork', forkedFromId: 'root' }, { id: 'unknown', forkedFromId: 'root' }];
  const doc = new JSDOM(renderSessionStatus({ thread, relatedThreads, chatsExpanded: true })).window.document;
  expect([...doc.querySelectorAll('[data-status-open-thread]')].map(node => node.getAttribute('data-status-open-thread'))).toEqual(['root', 'nested']);
  expect(doc.querySelector('#statusRelatedChats')?.hasAttribute('hidden')).toBe(false);
  expect(doc.querySelector('[data-status-toggle-chats]')?.getAttribute('aria-expanded')).toBe('true');
  expect(doc.querySelector('.status-chat-primary')?.textContent).toContain('child');
});

test('localizes labels without changing identifiers, paths or model configuration', () => {
  const i18n = createI18n({ languages: ['zh-CN'], storage: undefined });
  const doc = new JSDOM(renderSessionStatus({ thread: { id: 'Working', status: { type: 'active', activeFlags: ['waitingOnApproval'] } }, name: 'Chat name', model: 'fixture', effort: 'High', cwd: '/home/Working', branch: 'main', connected: true, transport: 'sse', usage: { modelContextWindow: 1000, last: { totalTokens: 250 }, total: { inputTokens: 200, outputTokens: 50 } } }, i18n.t)).window.document;
  expect(doc.body.textContent).toContain('等待审批');
  expect(doc.body.textContent).toContain('已用 25%');
  expect(doc.body.textContent).toContain('剩余 75%');
  expect(doc.querySelector('[data-status-copy]')?.getAttribute('data-status-copy')).toBe('Working');
  expect(doc.querySelector('#summaryWorkspace')?.textContent).toBe('/home/Working');
  expect(doc.body.textContent).toContain('High');
  expect(doc.body.textContent).toContain('SSE');
});
