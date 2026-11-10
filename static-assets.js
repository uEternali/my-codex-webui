import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

const compress = promisify(gzip);
export const acceptsGzip = header => String(header || '').split(',').some(part => {
  const [name, ...parameters] = part.trim().toLowerCase().split(';');
  return name === 'gzip' && !parameters.some(parameter => /^\s*q\s*=\s*0(?:\.0*)?\s*$/.test(parameter));
});
const matchesEtag = (header, etag) => String(header || '').split(',').some(value => value.trim() === '*' || value.trim().replace(/^W\//, '') === etag.replace(/^W\//, ''));

// Call only after the route's authorization and safe-path checks. Revalidate
// browser caches on every refresh so a deployment never pins an old bundle.
export function createStaticAssetSender({ maxEntries = 64, maxBytes = 16 * 1024 * 1024 } = {}) {
  const cache = new Map();
  let bytes = 0;
  const trim = () => {
    while (cache.size > maxEntries || bytes > maxBytes) {
      const [file, entry] = cache.entries().next().value;
      cache.delete(file); bytes -= entry.bytes;
    }
  };
  return async function sendStaticAsset(req, res, file, contentType, cacheControl = 'private, no-cache') {
    const stat = statSync(file);
    const version = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    let entry = cache.get(file);
    if (entry?.version !== version) {
      if (entry) { cache.delete(file); bytes -= entry.bytes; }
      const body = readFileSync(file);
      entry = { version, body, etag: `W/"${createHash('sha256').update(body).digest('hex')}"`, bytes: body.length, compressed: null };
      cache.set(file, entry); bytes += entry.bytes; trim();
    } else {
      cache.delete(file); cache.set(file, entry);
    }
    const headers = { 'content-type': contentType, 'cache-control': cacheControl, etag: entry.etag, vary: 'Accept-Encoding', 'x-content-type-options': 'nosniff' };
    if ((req.method === 'GET' || req.method === 'HEAD') && matchesEtag(req.headers['if-none-match'], entry.etag)) {
      res.writeHead(304, headers); res.end(); return;
    }
    let body = entry.body;
    if (body.length >= 1024 && /^(?:text\/|application\/json|image\/svg\+xml)/.test(contentType) && acceptsGzip(req.headers['accept-encoding'])) {
      entry.compressed ||= compress(entry.body, { level: 6 }).then(compressed => {
        if (cache.get(file) === entry) { entry.bytes += compressed.length; bytes += compressed.length; trim(); }
        return compressed;
      });
      body = await entry.compressed;
      headers['content-encoding'] = 'gzip';
    }
    headers['content-length'] = String(body.length);
    res.writeHead(200, headers); res.end(req.method === 'HEAD' ? undefined : body);
  };
}
