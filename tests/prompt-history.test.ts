import { describe, expect, test } from 'bun:test';
import { createPromptHistory } from '../public/prompt-history.js';
import { loadSidebarThreads } from '../public/sidebar-threads.js';

describe('composer input history', () => {
  test('browses a stable session snapshot and returns to the empty input', () => {
    let entries = ['first', 'second\nline'];
    const history = createPromptHistory({ getEntries: () => entries });
    expect(history.navigate('ArrowUp', '')).toBe('second\nline');
    entries = ['changed during refresh'];
    expect(history.navigate('ArrowUp', 'second\nline')).toBe('first');
    expect(history.navigate('ArrowUp', 'first')).toBe('first');
    expect(history.navigate('ArrowDown', 'first')).toBe('second\nline');
    expect(history.navigate('ArrowDown', 'second\nline')).toBe('');
    expect(history.navigate('ArrowUp', '')).toBe('second\nline');
  });
  test('never replaces an existing draft and stops recall once editing begins', () => {
    const history = createPromptHistory({ getEntries: () => ['old', 'new'] });
    expect(history.navigate('ArrowUp', 'unsent')).toBeNull();
    expect(history.navigate('ArrowUp', '')).toBe('new');
    history.reset();
    expect(history.navigate('ArrowUp', 'new')).toBeNull();
    expect(history.navigate('ArrowDown', 'new edited')).toBeNull();
    expect(history.navigate('ArrowUp', '')).toBe('new');
  });
  test('recalls a new submission before the native history catches up', () => {
    const history = createPromptHistory({ getEntries: () => ['previous'] });
    history.remember('latest', 'chat');
    expect(history.navigate('ArrowUp', '', 'chat')).toBe('latest');
    expect(history.navigate('ArrowUp', 'latest', 'chat')).toBe('previous');
  });
  test('uses bounded browser history in a new chat and tolerates unavailable storage', () => {
    let saved = '';
    const storage = { getItem: () => saved, setItem: (_key, value) => { saved = value; } };
    const history = createPromptHistory({ storage });
    for (let i = 0; i < 120; i++) history.remember(`input ${i}`);
    expect(JSON.parse(saved)).toHaveLength(100);
    expect(createPromptHistory({ storage }).navigate('ArrowUp', '')).toBe('input 119');
    const broken = createPromptHistory({ storage: { getItem() { throw Error(); }, setItem() { throw Error(); } } });
    broken.remember('still works');
    expect(broken.navigate('ArrowUp', '')).toBe('still works');
  });
});

describe('sidebar summaries', () => {
  test('loads every page, deduplicates IDs and orders by recency', async () => {
    const calls = [];
    const result = await loadSidebarThreads(async (_method, params) => {
      calls.push(params);
      return params.cursor ? { data: [{ id: 'new', recencyAt: 30 }, { id: 'middle', updatedAt: 20 }], nextCursor: null }
        : { data: [{ id: 'old', updatedAt: 10 }, { id: 'new', recencyAt: 25 }], nextCursor: 'next' };
    });
    expect(result.data.map(thread => thread.id)).toEqual(['new', 'middle', 'old']);
    expect(calls[1].cursor).toBe('next');
    expect(calls[0].sortKey).toBe('recency_at');
  });
  test('fails rather than returning a silently truncated list on a repeated cursor', async () => {
    await expect(loadSidebarThreads(async () => ({ data: [], nextCursor: 'repeat' }))).rejects.toThrow('complete chat list');
  });
});
