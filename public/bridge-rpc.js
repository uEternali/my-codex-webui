const READ_METHODS = new Set(['host/thread/live', 'thread/read', 'thread/turns/list', 'thread/list', 'thread/goal/get', 'model/list', 'permissionProfile/list']);
export const bridgeRequestTimeout = method => READ_METHODS.has(method) ? 45_000 : 120_000;
export const isBridgeConnectionError = error => error?.silentTransportSwitch || error?.code === 'BRIDGE_REQUEST_TIMEOUT';

function timeoutError(method) {
  const error = new Error(`Codex bridge response timed out: ${method}. The request may still have completed; check its status before retrying.`);
  error.code = 'BRIDGE_REQUEST_TIMEOUT';
  return error;
}

export function waitForRpcResponse(pending, id, send, { method, timeoutMs = bridgeRequestTimeout(method), onTimeout = () => {}, schedule = setTimeout, cancel = clearTimeout } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    // The transport dispatcher can remove the map entry before resolving it.
    let settled = false;
    const settle = callback => value => {
      if (settled) return; settled = true;
      if (pending.get(id) === entry) pending.delete(id);
      cancel(timer); callback(value);
    };
    const entry = { resolve: settle(resolve), reject: settle(reject) };
    pending.set(id, entry);
    timer = schedule(() => { if (settled) return; entry.reject(timeoutError(method)); onTimeout(); }, timeoutMs);
    try { send(); } catch (error) { entry.reject(error); }
  });
}

export async function postBridgeJson(path, payload, { fetchImpl = fetch, timeoutMs = bridgeRequestTimeout(payload.method), schedule = setTimeout, cancel = clearTimeout } = {}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = schedule(() => { const error = timeoutError(payload.method || path); reject(error); controller.abort(); }, timeoutMs);
  });
  try {
    return await Promise.race([deadline, (async () => {
      const response = await fetchImpl(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), cache: 'no-store', signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      return { response, data };
    })()]);
  } finally { cancel(timer); }
}
