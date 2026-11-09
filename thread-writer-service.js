import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function writerLockMatches(locks, { dev, ino }) {
  const device = BigInt(dev), inode = BigInt(ino);
  const major = ((device >> 8n) & 0xfffn) | ((device >> 32n) & 0xfffff000n);
  const minor = (device & 0xffn) | ((device >> 12n) & 0xffffff00n);
  return String(locks).split('\n').some(line => {
    const match = /^\d+:\s+FLOCK\s+ADVISORY\s+WRITE\s+\d+\s+([\da-f]+):([\da-f]+):(\d+)\s+0\s+EOF\s*$/i.exec(line);
    return match && BigInt('0x' + match[1]) === major && BigInt('0x' + match[2]) === minor && BigInt(match[3]) === inode;
  });
}

// Codex may return null admission state for an unloaded thread owned by another
// process. Linux exposes its existing writer flock without acquiring that lock,
// resuming a goal, or retaining a session in the WebUI app-server.
export function hasActiveThreadWriter(codexHome, threadId) {
  if (process.platform !== 'linux' || !/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(threadId || '')) return null;
  try {
    const stat = lstatSync(join(codexHome, 'thread-writer-locks', threadId + '.lock'), { bigint: true });
    if (!stat.isFile()) return null;
    return writerLockMatches(readFileSync('/proc/locks', 'utf8'), stat);
  } catch { return null; } // Older runtimes/platforms still report conflicts when input is submitted.
}
