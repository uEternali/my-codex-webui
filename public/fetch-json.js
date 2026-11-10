// Bound the full response, including body decoding, rather than just waiting
// for headers. Aborting also releases a stalled connection on mobile browsers.
export async function fetchJson(path, { timeoutMs = 15_000, fetchImpl = fetch, ...init } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Request timed out: ${path}`));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(path, { cache: 'no-store', ...init, signal: controller.signal });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        const error = new Error(data.error || `Request failed: ${path} (HTTP ${response.status})`);
        error.status = response.status;
        throw error;
      }
      return response.json();
    })()]);
  } finally { clearTimeout(timer); }
}
