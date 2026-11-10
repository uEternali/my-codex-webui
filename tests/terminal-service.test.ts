import { mkdtempSync, realpathSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'bun:test';
import { createTerminalSession, normalizeTerminalResize, resolveTerminalCwd } from '../terminal-service.js';

describe('terminal service', () => {
  test('accepts bounded PTY sizes and rejects malformed resize messages', () => {
    expect(normalizeTerminalResize({ type: 'resize', cols: 120, rows: 32 })).toEqual({ cols: 120, rows: 32 });
    expect(normalizeTerminalResize({ type: 'resize', cols: 0, rows: 32 })).toBeNull();
    expect(normalizeTerminalResize({ type: 'resize', cols: 120, rows: 5000 })).toBeNull();
    expect(normalizeTerminalResize({ type: 'data', cols: 120, rows: 32 })).toBeNull();
  });

  test('keeps terminal cwd inside the same allowed browse roots', () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'codex-webui-test-root-')));
    const project = realpathSync(mkdtempSync(join(root, 'project-')));
    const outside = realpathSync(mkdtempSync(join(tmpdir(), 'codex-webui-test-outside-')));
    const roots = [root];
    expect(resolveTerminalCwd(project, roots, root)).toBe(project);
    expect(resolveTerminalCwd(outside, roots, root)).toBe(root);
    expect(resolveTerminalCwd(null, roots, root)).toBe(root);
  });

  test('reports a missing PTY worker runtime without crashing the server', async () => {
    const previous = process.env.CODEX_WEBUI_NODE;
    process.env.CODEX_WEBUI_NODE = '/definitely/missing/codex-webui-node';
    try {
      const result = await new Promise(resolve => {
        const session = createTerminalSession({
          cwd: tmpdir(),
          onData: () => {},
          onExit: event => { session.kill(); resolve(event); },
        });
      });
      expect(result.exitCode).toBe(1);
    } finally {
      if (previous === undefined) delete process.env.CODEX_WEBUI_NODE;
      else process.env.CODEX_WEBUI_NODE = previous;
    }
  });

  test('uses the system hostname in the shell instead of the WebUI bind address', async () => {
    const previousHost = process.env.HOST, previousShell = process.env.SHELL;
    process.env.HOST = '100.65.202.49'; process.env.SHELL = '/bin/sh';
    let session, timer;
    try {
      const output = await new Promise<string>((resolveOutput, reject) => {
        let text = '';
        timer = setTimeout(() => reject(new Error('Terminal hostname check timed out')), 5000);
        session = createTerminalSession({ cwd: tmpdir(), onData: data => { text += data; }, onExit: () => resolveOutput(text) });
        session.write('printf "\\nHOST_FIX=%s\\n" "$HOST"; exit\r');
      });
      expect(output).toContain(`HOST_FIX=${hostname()}`);
      expect(output).not.toContain('HOST_FIX=100.65.202.49');
    } finally {
      clearTimeout(timer); session?.kill();
      if (previousHost === undefined) delete process.env.HOST; else process.env.HOST = previousHost;
      if (previousShell === undefined) delete process.env.SHELL; else process.env.SHELL = previousShell;
    }
  });
});
