import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBrowsePath } from './folder-service.js';
import { LOCAL_IMAGE_MAX_BYTES, resolveLocalImage } from './image-service.js';

export const FILE_PREVIEW_MAX_BYTES = 512 * 1024;
const MAX_PREVIEW_LINES = 10000;
const imageExtensions = new Set(['.avif', '.bmp', '.gif', '.jpeg', '.jpg', '.png', '.webp']);
const inside = (path, root) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
const revisionOf = metadata => [metadata.dev, metadata.ino, metadata.size, metadata.mtimeMs, metadata.ctimeMs].join('-');

async function workspaceTarget(cwd, path, allowedRoots) {
  if (typeof cwd !== 'string' || !cwd || cwd.length > 8192 || cwd.includes('\0')) throw new Error('Choose a project to browse its files');
  if (typeof path !== 'string' || path.length > 8192 || path.includes('\0') || isAbsolute(path)) throw new Error('Invalid project file path');
  const root = await realpath(resolveBrowsePath(cwd, allowedRoots));
  const candidate = resolve(root, path);
  if (!inside(candidate, root)) throw new Error('File is outside the project');
  const metadata = await lstat(candidate);
  if (metadata.isSymbolicLink()) throw new Error('Symbolic links are not previewed');
  const target = await realpath(candidate);
  if (!inside(target, root)) throw new Error('File is outside the project');
  return { root, target, metadata, path: relative(root, target).split(sep).join('/') };
}

export async function listWorkspaceDirectory(cwd, path = '', { allowedRoots = [], limit = 1000, revision } = {}) {
  const file = await workspaceTarget(cwd, path, allowedRoots);
  if (!file.metadata.isDirectory()) throw new Error('Folder is unavailable');
  const currentRevision = revisionOf(file.metadata);
  if (revision === currentRevision) return { unchanged: true, revision: currentRevision };
  const entries = [], maximum = Math.max(1, Math.min(limit, 1000));
  let truncated = false;
  for await (const entry of await opendir(file.target)) {
    const kind = entry.isDirectory() ? 'folder' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'link' : null;
    if (!kind) continue;
    if (entries.length === maximum) { truncated = true; break; }
    entries.push({ name: entry.name, path: [file.path, entry.name].filter(Boolean).join('/'), kind });
  }
  entries.sort((a, b) => Number(b.kind === 'folder') - Number(a.kind === 'folder') || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { cwd: file.root, path: file.path, entries, truncated, revision: currentRevision };
}

function decodeText(bytes) {
  try {
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
    const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
    if (/[\x00-\x08\x0b\x0e-\x1f]/.test(text)) return null;
    return { text, encoding: encoding.toUpperCase() };
  } catch { return null; }
}

export async function previewWorkspaceFile(cwd, path, { allowedRoots = [], maxBytes = FILE_PREVIEW_MAX_BYTES, revision } = {}) {
  const file = await workspaceTarget(cwd, path, allowedRoots);
  if (!file.metadata.isFile()) throw new Error('File is unavailable');
  const base = { cwd: file.root, path: file.path, name: basename(file.target), size: file.metadata.size, fileUrl: pathToFileURL(file.target).href, revision: revisionOf(file.metadata) };
  if (revision === base.revision) return { unchanged: true, revision: base.revision };
  if (imageExtensions.has(extname(file.target).toLowerCase())) {
    if (base.size > LOCAL_IMAGE_MAX_BYTES) return { ...base, kind: 'unavailable', reason: 'too-large' };
    resolveLocalImage(file.target, { cwd: file.root, allowedRoots: [file.root] });
    return { ...base, kind: 'image' };
  }
  if (base.size > maxBytes) return { ...base, kind: 'unavailable', reason: 'too-large' };
  // Bound both memory use and rendering work, including files growing during a read.
  const handle = await open(file.target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new Error('File is unavailable');
    base.revision = revisionOf(metadata);
    if (metadata.size > maxBytes) return { ...base, size: metadata.size, kind: 'unavailable', reason: 'too-large' };
    const bytes = Buffer.alloc(Math.min(metadata.size, maxBytes) + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > maxBytes) return { ...base, kind: 'unavailable', reason: 'too-large' };
    const decoded = decodeText(bytes.subarray(0, length));
    if (!decoded) return { ...base, kind: 'unavailable', reason: 'binary' };
    const lineCount = decoded.text.split(/\r\n|\n|\r/).length;
    if (lineCount > MAX_PREVIEW_LINES) return { ...base, kind: 'unavailable', reason: 'too-many-lines' };
    return { ...base, size: length, kind: 'text', ...decoded, lineCount };
  } finally { await handle.close(); }
}
