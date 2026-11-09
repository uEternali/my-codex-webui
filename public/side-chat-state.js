const terminal = status => ['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(status);

// Ephemeral threads cannot use thread/turns/list. Keep only their own streamed
// turns in memory, using the same reducer on the bridge and in the browser.
export class SideChatTranscript {
  constructor() { this.turns = new Map(); this.activeTurnId = null; this.error = null; }
  mergeTurn(turn) {
    if (!turn?.id) return null;
    const stored = this.turns.get(turn.id) || { id: turn.id, items: [] };
    if (terminal(stored.status) && !terminal(turn.status)) return stored;
    const items = new Map(stored.items.map(item => [item.id, item]));
    for (const item of turn.items || []) items.set(item.id, { ...items.get(item.id), ...item });
    Object.assign(stored, Object.fromEntries(Object.entries(turn).filter(([key, value]) => key !== 'items' && value !== undefined)), { items: [...items.values()] });
    this.turns.set(turn.id, stored);
    if (stored.status === 'inProgress') this.activeTurnId = stored.id;
    else if (terminal(stored.status) && this.activeTurnId === stored.id) this.activeTurnId = null;
    return stored;
  }
  item(params, type) {
    const turn = this.mergeTurn({ id: params.turnId, status: 'inProgress' });
    if (!turn || terminal(turn.status)) return null;
    let item = turn.items.find(item => item.id === params.itemId);
    if (!item) { item = { id: params.itemId, type, status: 'inProgress' }; turn.items.push(item); }
    return item;
  }
  notification(method, params) {
    if (method === 'turn/started') { this.mergeTurn({ ...params.turn, status: 'inProgress' }); this.error = null; }
    else if (method === 'turn/completed') this.mergeTurn({ ...params.turn, status: params.turn.status || 'completed' });
    else if (method === 'item/started' || method === 'item/completed') {
      const turn = this.mergeTurn({ id: params.turnId }); if (!turn) return;
      const index = turn.items.findIndex(item => item.id === params.item.id);
      if (terminal(turn.status) && method === 'item/started') return;
      const item = { ...params.item, ...(method === 'item/started' ? { status: 'inProgress' } : {}) };
      if (index < 0) turn.items.push(item); else turn.items[index] = { ...turn.items[index], ...item };
    } else if (method === 'item/agentMessage/delta') {
      const item = this.item(params, 'agentMessage'); if (item) item.text = (item.text || '') + (params.delta || '');
    } else if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') {
      const item = this.item(params, 'reasoning'); if (!item) return;
      const field = method.includes('summaryText') ? 'summary' : 'content', index = params.summaryIndex ?? params.contentIndex ?? 0;
      item[field] ||= []; item[field][index] = (item[field][index] || '') + (params.delta || '');
    } else if (method === 'item/commandExecution/outputDelta' || method === 'item/fileChange/outputDelta') {
      const item = this.item(params, method.includes('commandExecution') ? 'commandExecution' : 'fileChange');
      if (item) item.aggregatedOutput = (item.aggregatedOutput || '') + (params.delta || '');
    } else if (method === 'item/fileChange/patchUpdated') {
      const item = this.item(params, 'fileChange'); if (item) item.changes = params.changes || [];
    } else if (method === 'error') {
      this.error = params.error || params;
      if (!params.willRetry) {
        this.mergeTurn({ id: params.turnId || this.activeTurnId, status: 'failed', error: this.error }); this.activeTurnId = null;
      }
    } else if (method === 'thread/closed') this.activeTurnId = null;
  }
  snapshot() { return { turns: [...this.turns.values()], activeTurnId: this.activeTurnId, error: this.error }; }
  load(snapshot) {
    this.turns = new Map((snapshot.turns || []).map(turn => [turn.id, turn]));
    this.activeTurnId = snapshot.activeTurnId || null; this.error = snapshot.error || null;
  }
}
