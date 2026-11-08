const approvalMethods = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval']);

export function isApprovalRequest(request) {
  return approvalMethods.has(request?.method);
}

export class PendingRequestStore {
  constructor() { this.requests = new Map(); }
  record(request) {
    if (request?.id === undefined || typeof request.method !== 'string') return;
    this.requests.set(request.id, request);
  }
  replace(requests = []) {
    this.clear();
    for (const request of requests) this.record(request);
  }
  snapshot() { return [...this.requests.values()]; }
  has(id) { return this.requests.has(id); }
  resolve(id) { return this.requests.delete(id); }
  clear() { this.requests.clear(); }
  handleNotification({ method, params: p = {} }) {
    if (method === 'serverRequest/resolved') return this.resolve(p.requestId);
    const turnId = method === 'turn/completed' ? p.turn?.id : p.turnId;
    const itemId = method === 'item/completed' ? p.item?.id : null;
    const closed = method === 'thread/closed' || method === 'thread/deleted';
    if (!closed && method !== 'turn/completed' && method !== 'item/completed') return false;
    if (!p.threadId || !closed && !turnId || method === 'item/completed' && !itemId) return false;
    let changed = false;
    for (const [id, request] of this.requests) {
      const target = request.params || {};
      if (target.threadId === p.threadId && (closed || target.turnId === turnId) && (!itemId || target.itemId === itemId)) {
        this.requests.delete(id); changed = true;
      }
    }
    return changed;
  }
}
