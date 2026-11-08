// Shared by the small JSON APIs; file uploads have a separate streaming limit.
export function readJsonBody(req, maxBytes = 256_000) {
  return new Promise((resolve, reject) => {
    let chunks = [], size = 0, settled = false;
    const fail = error => {
      if (settled) return;
      settled = true; chunks = []; reject(error); req.resume();
    };
    req.on('data', chunk => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > maxBytes) return fail(new Error('Bridge payload too large'));
      chunks.push(bytes);
    });
    req.on('error', fail);
    req.on('aborted', () => fail(new Error('Request interrupted')));
    req.on('end', () => {
      if (settled) return;
      try { const body = JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}'); settled = true; chunks = []; resolve(body); }
      catch { fail(new Error('Invalid JSON payload')); }
    });
  });
}
