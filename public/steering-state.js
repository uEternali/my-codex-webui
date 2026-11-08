const storageKey = 'codex-webui-pending-steers-v1';
const inputKey = input => JSON.stringify((input || []).map(({ type, text, path, url, imageUrl }) => ({ type, text, path, url, imageUrl })));

export function createClientMessageId() {
  // randomUUID is restricted to secure contexts; the LAN WebUI also uses HTTP.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SteeringStore {
  constructor(storage) {
    this.storage = storage;
    this.entries = new Map();
    try {
      for (const entry of JSON.parse(storage?.getItem(storageKey) || '[]')) {
        if (!entry.clientId || !entry.threadId || !entry.turnId || !Array.isArray(entry.input)) continue;
        // A refresh can race an acknowledgment. Never assume an unknown request
        // failed, and never replay it automatically.
        if (entry.status === 'sending' || entry.status === 'interrupting') entry.status = 'unconfirmed';
        this.entries.set(entry.clientId, entry);
      }
    } catch { /* Storage can be disabled or contain an incomplete old value. */ }
  }
  save() { try { this.storage?.setItem(storageKey, JSON.stringify([...this.entries.values()])); } catch {} }
  list(threadId, turnId) { return [...this.entries.values()].filter(entry => entry.threadId === threadId && (!turnId || entry.turnId === turnId)); }
  add(entry) { this.entries.set(entry.clientId, { ...entry, status: 'sending' }); this.save(); return this.entries.get(entry.clientId); }
  update(clientId, status) { const entry = this.entries.get(clientId); if (entry) { entry.status = status; this.save(); } return entry; }
  remove(clientId) { const entry = this.entries.get(clientId); this.entries.delete(clientId); this.save(); return entry; }
  match(item, threadId, turnId) {
    const entries = this.list(threadId, turnId);
    return item.clientId ? entries.find(entry => entry.clientId === item.clientId)
      : entries.find(entry => inputKey(entry.input) === inputKey(item.content));
  }
  commit(item, threadId, turnId) { const entry = this.match(item, threadId, turnId); return entry && this.remove(entry.clientId); }
}
