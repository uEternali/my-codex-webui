import { SideChatTranscript } from './public/side-chat-state.js';

const instructions = 'This is a temporary side chat connected to an existing conversation. Use the inherited conversation as context to answer the user’s side questions. Do not continue the parent task or its goal automatically. Work in this side chat must not interrupt the parent conversation.';
const keyPattern = /^[a-zA-Z0-9_-]{16,100}$/;

// Native ephemeral threads have no rollout file. Unsubscribing releases their
// runtime; they must never enter the saved fork or attachment indexes.
export class SideChatService {
  constructor({ request, now = Date.now, ttl = 5 * 60_000 }) {
    this.request = request; this.now = now; this.ttl = ttl;
    this.entries = new Map(); this.closed = new Map();
  }
  key(value) {
    if (typeof value !== 'string' || !keyPattern.test(value)) throw new Error('Invalid side chat key');
    return value;
  }
  entry(key) {
    const entry = this.entries.get(this.key(key));
    if (!entry || entry.closing) throw new Error('Side chat is no longer available. Close this tab and open a new side chat.');
    entry.touched = this.now(); return entry;
  }
  async start(params) {
    const key = this.key(params.key), parentId = params.parentThreadId || null;
    if (this.closed.has(key)) throw new Error('This side chat was closed');
    let entry = this.entries.get(key);
    if (entry) {
      if (entry.parentId !== parentId || entry.closing) throw new Error('Side chat context has changed');
      entry.touched = this.now(); return entry.start;
    }
    if (parentId !== null && (typeof parentId !== 'string' || !parentId.trim())) throw new Error('Invalid parent thread');
    if (this.entries.size >= 50) throw new Error('Too many temporary side chats are open');
    entry = { key, parentId, touched: this.now(), thread: null, transcript: new SideChatTranscript(), sending: null, closing: null };
    this.entries.set(key, entry);
    entry.start = (async () => {
      const common = { ephemeral: true, config: { thread_unload_delay_secs: 0 }, developerInstructions: instructions, threadSource: 'webui-side-chat' };
      const result = await this.request(parentId ? 'thread/fork' : 'thread/start', parentId
        ? { ...common, threadId: parentId, excludeTurns: true }
        : { ...common, cwd: params.cwd, model: params.model });
      if (!result.thread?.ephemeral || result.thread.path) throw new Error('Codex did not create a temporary side chat');
      entry.thread = result.thread;
      return { thread: { ...result.thread, turns: [] }, parentThreadId: parentId };
    })();
    try { return await entry.start; }
    catch (error) { if (this.entries.get(key) === entry) this.entries.delete(key); throw error; }
  }
  notification(method, params) {
    const entry = [...this.entries.values()].find(item => item.thread?.id === params.threadId);
    if (!entry) return;
    entry.transcript.notification(method, params);
  }
  async read({ key }) {
    const entry = this.entry(key); await entry.start;
    return structuredClone({ threadId: entry.thread.id, ...entry.transcript.snapshot() });
  }
  async send({ key, text, model, effort }) {
    const entry = this.entry(key);
    if (typeof text !== 'string' || !text.trim() || text.length > 200_000) throw new Error('Invalid side chat message');
    if (entry.sending || entry.transcript.activeTurnId) throw new Error('Side chat is already working');
    entry.sending = (async () => {
      await entry.start;
      if (entry.closing) throw new Error('This side chat was closed');
      const result = await this.request('turn/start', { threadId: entry.thread.id, input: [{ type: 'text', text: text.trim() }], ...(model ? { model } : {}), ...(effort ? { effort } : {}) });
      if (result.turn?.id && !entry.transcript.turns.has(result.turn.id)) entry.transcript.mergeTurn(result.turn);
      return result;
    })();
    try { return await entry.sending; } finally { entry.sending = null; }
  }
  async interrupt({ key }) {
    const entry = this.entry(key); await entry.start;
    if (entry.sending) await entry.sending.catch(() => {});
    if (entry.transcript.activeTurnId) await this.request('turn/interrupt', { threadId: entry.thread.id, turnId: entry.transcript.activeTurnId });
    return {};
  }
  async close({ key }) {
    key = this.key(key);
    const entry = this.entries.get(key);
    if (!entry) { this.closed.set(key, this.now()); return { closed: true }; }
    if (entry.closing) return entry.closing;
    entry.closing = (async () => {
      await entry.start.catch(() => {});
      if (entry.sending) await entry.sending.catch(() => {});
      if (entry.thread) {
        if (entry.transcript.activeTurnId) await this.request('turn/interrupt', { threadId: entry.thread.id, turnId: entry.transcript.activeTurnId });
        await this.request('thread/unsubscribe', { threadId: entry.thread.id });
      }
      this.entries.delete(key); this.closed.set(key, this.now());
      return { closed: true };
    })();
    try { return await entry.closing; }
    catch (error) { entry.closing = null; throw error; }
  }
  async sweep() {
    const now = this.now();
    for (const [key, at] of this.closed) if (now - at > this.ttl * 2) this.closed.delete(key);
    await Promise.allSettled([...this.entries.values()].filter(entry => now - entry.touched > this.ttl).map(entry => this.close({ key: entry.key })));
  }
  reset() { this.entries.clear(); this.closed.clear(); }
}
