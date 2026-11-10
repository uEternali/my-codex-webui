import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createGoalController } from '../public/goals.js';

test('goal fallback reads are throttled while notifications and reconnect stay immediate', async () => {
  const dom = new JSDOM(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'));
  let time = 0; const reads: string[] = [];
  const controller = createGoalController({ root: dom.window.document, now: () => time, getThread: () => ({ id: 'a' }), ensureThread: async () => ({ id: 'a' }), rpc: async (_, { threadId }) => { reads.push(threadId); return { goal: null }; } });
  try {
    controller.selectThread('a'); await Promise.resolve();
    for (time = 800; time < 10_000; time += 800) await controller.refresh();
    expect(reads).toEqual(['a']);
    controller.notification('thread/goal/updated', { threadId: 'a', goal: { threadId: 'a', objective: 'Updated immediately', status: 'active' } });
    expect(dom.window.document.querySelector('#goalObjectivePreview').textContent).toBe('Updated immediately');
    await controller.refresh(); expect(reads).toEqual(['a', 'a']);
    await controller.refresh({ force: true }); expect(reads).toHaveLength(3);
    controller.selectThread('b'); await Promise.resolve(); expect(reads.at(-1)).toBe('b');
  } finally { dom.window.close(); }
});
