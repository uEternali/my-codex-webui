import { expect, test } from 'bun:test';
import { HISTORY_ITEM_PAGE_SIZE, historyItemWindow } from '../public/history-window.js';

test('one giant turn has a bounded first window and keeps the original items intact', () => {
  const items = Array.from({ length: 2674 }, (_, index) => ({ id: String(index) }));
  const original = [...items], window = historyItemWindow(items);
  expect(window.visible).toHaveLength(80);
  expect(window.visible[0]).toBe(items[2594]);
  expect(window.visible.at(-1)).toBe(items.at(-1));
  expect(window.hiddenCount).toBe(2594);
  expect(items).toEqual(original);
});

test('older pages and complete polling snapshots use the same explicit item budget', () => {
  const items = Array.from({ length: 2674 }, (_, index) => ({ id: String(index) }));
  const first = historyItemWindow(items);
  const second = historyItemWindow(items, first.limit + HISTORY_ITEM_PAGE_SIZE);
  expect(second.visible).toHaveLength(160);
  expect(second.hiddenCount).toBe(2514);
  expect(historyItemWindow([...items, { id: 'new' }], second.limit).visible).toHaveLength(160);
  expect(historyItemWindow(items.slice(-200), second.limit).visible).toHaveLength(160);
});

test('short and empty turns keep their complete history with safe bounds', () => {
  expect(historyItemWindow([{ id: 'small' }]).hiddenCount).toBe(0);
  expect(historyItemWindow(null).visible).toEqual([]);
  expect(historyItemWindow([], Number.NaN).limit).toBe(80);
});
