import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasActiveThreadWriter, writerLockMatches } from '../thread-writer-service.js';

test('matches the actual Codex writer flock by filesystem device and inode', () => {
  const stat = { dev: 0x830n, ino: 9007199254740993n };
  expect(writerLockMatches('8: FLOCK ADVISORY WRITE 123 08:30:9007199254740993 0 EOF', stat)).toBe(true);
  expect(writerLockMatches('8: FLOCK ADVISORY WRITE 123 08:31:9007199254740993 0 EOF', stat)).toBe(false);
  expect(writerLockMatches('8: FLOCK ADVISORY WRITE 123 08:30:9007199254740992 0 EOF', stat)).toBe(false);
});
test('ignores waiting locks, shared readers, and unrelated SQLite locks', () => {
  const stat = { dev: 0x830n, ino: 42n };
  for (const line of ['8: -> FLOCK ADVISORY WRITE 123 08:30:42 0 EOF', '8: FLOCK ADVISORY READ 123 08:30:42 0 EOF', '8: POSIX ADVISORY WRITE 123 08:30:42 0 EOF']) expect(writerLockMatches(line, stat)).toBe(false);
  expect(hasActiveThreadWriter('/tmp', '../anything')).toBeNull();
});
test.skipIf(process.platform !== 'linux')('reads and releases a real kernel flock without acquiring ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'webui-writer-test-')), id = '00000000-0000-0000-0000-000000000001';
  mkdirSync(join(root, 'thread-writer-locks'));
  const child = Bun.spawn(['python3', '-c', 'import fcntl,sys,time; f=open(sys.argv[1],"w"); fcntl.flock(f,fcntl.LOCK_EX); print("ready",flush=True); time.sleep(20)', join(root, 'thread-writer-locks', id + '.lock')], { stdout: 'pipe', stderr: 'inherit' });
  try {
    const reader = child.stdout.getReader(); await reader.read(); reader.releaseLock();
    expect(hasActiveThreadWriter(root, id)).toBe(true);
    child.kill(); await child.exited;
    expect(hasActiveThreadWriter(root, id)).toBe(false);
  } finally { child.kill(); await child.exited; rmSync(root, { recursive: true, force: true }); }
});
