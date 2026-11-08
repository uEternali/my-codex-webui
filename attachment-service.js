import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';

export const ATTACHMENT_MAX_BYTES = 25 * 1024 * 1024;
export class AttachmentError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
export function attachmentDirectory(env = process.env) {
  return resolve(env.CODEX_WEBUI_UPLOAD_DIR || join(env.CODEX_HOME || join(homedir(), '.codex'), 'codex-webui-uploads'));
}
export function readAttachmentBody(req, maxBytes = ATTACHMENT_MAX_BYTES) {
  return new Promise((resolveBody, reject) => {
    let chunks = [], size = 0, settled = false;
    const fail = error => { if (settled) return; settled = true; chunks = []; reject(error); req.resume?.(); };
    const declared = req.headers?.['content-length'];
    if (declared && (!/^\d+$/.test(String(declared)) || Number(declared) > maxBytes)) {
      fail(new AttachmentError('Each attachment must be 25 MB or smaller.', 413)); return;
    }
    req.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) { fail(new AttachmentError('Each attachment must be 25 MB or smaller.', 413)); return; }
      chunks.push(bytes);
    });
    req.on('end', () => { if (!settled) { settled = true; resolveBody(Buffer.concat(chunks, size)); } });
    req.on('aborted', () => fail(new AttachmentError('Upload interrupted. Please try again.')));
    req.on('error', fail);
  });
}
function detectedImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return ['image/png', '.png'];
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['image/jpeg', '.jpg'];
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return ['image/webp', '.webp'];
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return ['image/gif', '.gif'];
  return null;
}
export function storeAttachment(bytes, { filename, contentType = '', directory = attachmentDirectory(), maxBytes = ATTACHMENT_MAX_BYTES } = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!bytes.length) throw new AttachmentError('Empty files cannot be attached.');
  if (bytes.length > maxBytes) throw new AttachmentError('Each attachment must be 25 MB or smaller.', 413);
  const name = basename(String(filename || '').replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, ' ').trim();
  if (!name || name === '.' || name === '..') throw new AttachmentError('A valid filename is required.');
  const image = detectedImage(bytes);
  if (!image && /\.(?:png|jpe?g|webp|gif)$/i.test(name)) throw new AttachmentError('This image file is invalid or unsupported.');
  const extension = image ? image[1] : extname(name).slice(0, 16).replace(/[^.a-zA-Z0-9_-]/g, '');
  let stem = basename(name, extname(name)).replace(/[^\p{L}\p{N}._ -]/gu, '_') || 'attachment';
  while (Buffer.byteLength(stem) > 140) stem = Array.from(stem).slice(0, -1).join('');
  const id = randomUUID();
  const dir = resolve(directory);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const filePath = join(dir, `${id}-${stem}${extension}`);
  writeFileSync(filePath, bytes, { flag: 'wx', mode: 0o600 });
  const suppliedType = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(contentType) ? contentType : 'application/octet-stream';
  return { id, name, path: filePath, size: bytes.length, contentType: image ? image[0] : suppliedType, isImage: Boolean(image) };
}
