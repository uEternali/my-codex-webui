import { expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { createTerminalTabs } from '../public/terminal-tabs.js';

test('terminal tabs capture their own project, preserve siblings and release only the closed tab', () => {
  const window = new JSDOM('<div id="tabs"></div><div id="hosts"></div>').window, doc = window.document;
  let cwd = '/project/a', active, empty = 0; const disposed = [], initialized = [];
  const tabs = createTerminalTabs({ tabList: doc.querySelector('#tabs'), hosts: doc.querySelector('#hosts'), getCwd: () => cwd, createState: (hostId, panelId) => ({ hostId, panelId }), initialize: state => initialized.push(state), dispose: state => disposed.push(state), onActive: state => active = state, onEmpty: () => empty++ });
  const first = tabs.add(); cwd = '/project/b'; const second = tabs.add();
  expect(first.cwd).toBe('/project/a'); expect(second.cwd).toBe('/project/b');
  tabs.select('terminal-1'); expect(active).toBe(first); expect(tabs.values()).toEqual([first, second]);
  doc.querySelector('[role=tab][aria-selected=true]').dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  expect(active).toBe(second);
  tabs.remove('terminal-1'); expect(disposed).toEqual([first]); expect(active).toBe(second);
  expect(doc.querySelectorAll('.terminal-host')).toHaveLength(1);
  tabs.remove('terminal-2'); expect(empty).toBe(1); expect(active).toBeNull();
  tabs.open(); expect(tabs.values()[0].cwd).toBe('/project/b'); expect(initialized.length).toBe(5);
});
