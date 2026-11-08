import { describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { mergeTimelineOrder, orderTimeline, timelineEvents } from '../public/conversation-order.js';
import { createClientMessageId, SteeringStore } from '../public/steering-state.js';

describe('native conversation order', () => {
  test('a delayed history snapshot inserts guidance without losing newer live events', () => {
    expect(mergeTimelineOrder(['prompt', 'reply', 'tool', 'new-reply', 'pending'], ['prompt', 'reply', 'guidance', 'tool']))
      .toEqual(['prompt', 'reply', 'guidance', 'tool', 'new-reply', 'pending']);
    expect(mergeTimelineOrder(['prompt', 'reply', 'guidance', 'tool', 'new-reply'], ['prompt', 'reply']))
      .toEqual(['prompt', 'reply', 'guidance', 'tool', 'new-reply']);
  });
  test('late guidance splits a tool group while retaining outputs and expansion', () => {
    const document = new JSDOM('<div id="stream"><div data-agent-activity-group data-activity-group-anchor="a"><div class="activity-items"><div class="activity-item expanded" data-item-id="a"></div><pre>output a</pre><div class="activity-item" data-item-id="b"></div><pre>output b</pre></div></div><article id="guide"></article></div>').window.document;
    const stream = document.querySelector('#stream')!, a = stream.querySelector('[data-item-id="a"]')!, b = stream.querySelector('[data-item-id="b"]')!, guide = document.querySelector('#guide')!;
    orderTimeline(stream, [a, guide, b], {
      createGroup(id: string) { const el = document.createElement('div'); el.dataset.agentActivityGroup = ''; el.dataset.activityGroupAnchor = id; el.innerHTML = '<div class="activity-items"></div>'; return el; },
      updateGroup() {}, standalone: () => false,
    });
    expect(timelineEvents(stream)).toEqual([a, guide, b]);
    expect(a.nextElementSibling!.textContent).toBe('output a');
    expect(b.nextElementSibling!.textContent).toBe('output b');
    expect(a.classList.contains('expanded')).toBe(true);
    expect(stream.querySelectorAll('[data-agent-activity-group]').length).toBe(2);
  });
});

describe('pending steering receipts', () => {
  const input = (text: string) => [{ type: 'text', text }];
  test('identical messages use client identity and an acknowledgment does not commit them', () => {
    const store = new SteeringStore();
    store.add({ clientId: 'a', threadId: 'thread', turnId: 'turn', input: input('same') });
    store.add({ clientId: 'b', threadId: 'thread', turnId: 'turn', input: input('same') });
    store.update('a', 'queued'); store.update('b', 'queued');
    expect(store.list('thread', 'turn').length).toBe(2);
    expect(store.commit({ clientId: 'b', content: input('same') }, 'thread', 'turn')?.clientId).toBe('b');
    expect(store.list('thread').map(entry => entry.clientId)).toEqual(['a']);
    expect(store.commit({ clientId: 'other', content: input('same') }, 'thread', 'turn')).toBeUndefined();
    expect(store.commit({ content: input('same') }, 'other-thread', 'turn')).toBeUndefined();
    expect(store.commit({ content: input('same') }, 'thread', 'turn')?.clientId).toBe('a');
  });
  test('refresh preserves accepted input and treats an unfinished request as unconfirmed', () => {
    const values = new Map(), storage = { getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value) };
    const first = new SteeringStore(storage);
    first.add({ clientId: 'a', threadId: 'thread', turnId: 'turn', input: input('queued') }); first.update('a', 'queued');
    first.add({ clientId: 'b', threadId: 'thread', turnId: 'turn', input: input('in flight') });
    const recovered = new SteeringStore(storage);
    expect(recovered.list('thread').map(entry => entry.status)).toEqual(['queued', 'unconfirmed']);
    recovered.commit({ clientId: 'a' }, 'thread', 'turn');
    expect(new SteeringStore(storage).list('thread').map(entry => entry.clientId)).toEqual(['b']);
  });
  test('client IDs work on HTTP LAN origins without crypto.randomUUID', () => {
    const ids = new Set(Array.from({ length: 20 }, createClientMessageId));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(/^[a-f\d]{8}-[a-f\d]{4}-4[a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/);
  });
});
