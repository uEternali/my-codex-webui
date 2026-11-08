import { describe, expect, test } from 'bun:test';
import { GoalStore, goalPresentation, parseGoalCommand } from '../public/goal-state.js';

describe('native Codex goals', () => {
  test('recognizes goal commands without intercepting ordinary messages', () => {
    expect(parseGoalCommand('/goal')).toEqual({ action: 'view' });
    expect(parseGoalCommand('/goal pause')).toEqual({ action: 'pause' });
    expect(parseGoalCommand(' /goal resume ')).toEqual({ action: 'resume' });
    expect(parseGoalCommand('/goal clear')).toEqual({ action: 'clear' });
    expect(parseGoalCommand('/goal Ship the feature\nand verify tests')).toEqual({ action: 'set', objective: 'Ship the feature\nand verify tests' });
    expect(parseGoalCommand('/goal pause the database migration')).toEqual({ action: 'set', objective: 'pause the database migration' });
    for (const text of ['go on', 'Explain /goal', '/goals', '/goalkeeper test']) expect(parseGoalCommand(text)).toBeNull();
  });

  test('keeps status truthful and only offers resume for a paused goal', () => {
    const labels = { active: 'Pursuing goal', paused: 'Goal paused', blocked: 'Goal stalled', usageLimited: 'Goal hit usage limits', budgetLimited: 'Goal unmet', complete: 'Goal achieved' };
    for (const [status, label] of Object.entries(labels)) {
      expect(goalPresentation({ status })).toEqual({ label, icon: status === 'active' ? 'loaderCircle' : status === 'paused' ? 'square' : status === 'complete' ? 'check' : 'triangleAlert', canPause: status === 'active', canResume: status === 'paused' });
    }
    expect(goalPresentation({ status: 'unknown' }).label).toBe('Goal unavailable');
  });

  test('isolates threads and prevents slow reads from undoing a notification or deletion', () => {
    const store = new GoalStore();
    const a = { threadId: 'a', objective: 'Goal A', status: 'active' };
    const b = { threadId: 'b', objective: 'Goal B', status: 'paused' };
    expect(store.set('a', a)).toBe(true); store.set('b', b);
    const old = store.revision('a');
    store.set('a', { ...a, status: 'complete' });
    expect(store.read('a', old, a)).toBe(false);
    expect(store.get('a').status).toBe('complete');
    const beforeClear = store.revision('a'); store.set('a', null);
    expect(store.read('a', beforeClear, a)).toBe(false);
    expect(store.get('a')).toBeNull(); expect(store.get('b')).toEqual(b);
    expect(store.set('a', b)).toBe(false);
  });
});
