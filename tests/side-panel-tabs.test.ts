import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createSidePanelTabs } from '../public/side-panel-tabs.js';
import { rightPanelBounds } from '../public/panel-resize.js';

test('a chooser becomes the selected feature in place, with independently removable tabs', () => {
  const window = new JSDOM('<div role="tablist"></div>').window, list = window.document.querySelector('div');
  const removed = [], selected = []; let empty = 0;
  const tabs = createSidePanelTabs({ list, onSelect: entry => selected.push(entry.id), onRemove: entry => removed.push(entry.id), onEmpty: () => empty++ });
  const first = tabs.launcher(); tabs.choose('terminal');
  expect(tabs.active?.id).toBe(first.id); expect(tabs.values()).toHaveLength(1);
  expect(first.button.textContent).toBe('Terminal');
  const next = tabs.launcher(); tabs.launcher(); expect(tabs.values()).toHaveLength(2);
  tabs.choose('browser'); expect(tabs.active?.id).toBe(next.id); expect(tabs.values()).toHaveLength(2);
  first.button.click(); expect(tabs.active).toBe(first);
  first.button.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(tabs.active).toBe(next);
  tabs.remove(first.id); expect(removed).toEqual([first.id]); expect(tabs.active).toBe(next);
  tabs.remove(next.id); expect(empty).toBe(1); expect(tabs.active).toBeNull();
});

test('width bounds leave the docked chat usable and constrain overlay widths', () => {
  expect(rightPanelBounds(1280, 275)).toEqual({ min: 280, max: 564 });
  expect(rightPanelBounds(1000, 275)).toEqual({ min: 280, max: 976 });
  expect(rightPanelBounds(1600, 275).max).toBe(884);
});

test('files and subagents reuse their existing tabs while terminals can have multiple tabs', () => {
  const window = new JSDOM('<div></div>').window;
  const tabs = createSidePanelTabs({ list: window.document.querySelector('div'), onSelect: () => {} });
  for (const kind of ['files', 'side-task', 'side-chat']) {
    const original = tabs.choose(kind), chooser = tabs.launcher();
    expect(tabs.choose(kind)).toBe(original);
    expect(tabs.active).toBe(original);
    expect(tabs.values().filter(entry => entry.kind === kind)).toHaveLength(1);
    expect(chooser.kind).toBe('launcher');
    tabs.remove(original.id); tabs.select(chooser.id);
    expect(tabs.choose(kind)?.id).toBe(chooser.id);
  }
  const first = tabs.choose('terminal'); tabs.launcher();
  const second = tabs.choose('terminal');
  expect(second?.id).not.toBe(first?.id);
  expect(tabs.values().filter(entry => entry.kind === 'terminal')).toHaveLength(2);
  window.close();
});

test('tab close waits for confirmation and cleanup, and cancellation preserves the chat', async () => {
  const window = new JSDOM('<div></div>').window;
  let confirm: (value: boolean) => void;
  const tabs = createSidePanelTabs({ list: window.document.querySelector('div'), onSelect: () => {}, beforeRemove: () => new Promise(resolve => { confirm = resolve; }) });
  const entry = tabs.open('side-chat'), cancelled = tabs.remove(entry.id);
  expect(tabs.active).toBe(entry); expect(entry.close.disabled).toBe(true);
  confirm!(false); expect(await cancelled).toBe(false); expect(tabs.active).toBe(entry);
  const accepted = tabs.remove(entry.id); confirm!(true);
  expect(await accepted).toBe(true); expect(tabs.values()).toHaveLength(0);
  window.close();
});
