import { isBridgeConnectionError } from './bridge-rpc.js';

// Cache a revision, not another copy of the conversation. Callers without
// conditional mode always get a fresh full snapshot (e.g. interrupt checks).
export function createThreadTurnReader(rpc) {
  let cached = null, generation = 0;
  return {
    reset() { cached = null; generation++; },
    async read(threadId, { conditional = false, onLive = () => {} } = {}) {
      const requestGeneration = generation;
      const sinceRevision = conditional && cached?.threadId === threadId ? cached.revision : null;
      let live;
      try {
        live = await rpc('host/thread/live', { threadId, ...(sinceRevision ? { sinceRevision } : {}) });
        onLive(live);
      } catch (error) { if (isBridgeConnectionError(error)) throw error; }
      if (sinceRevision && live?.unchanged === true && live.revision === sinceRevision) {
        return { unchanged: true, active: live.active === true, turn: null };
      }
      let turn = live?.active && live.turn;
      if (!turn) {
        try {
          const result = await rpc('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'full' });
          turn = result.data?.[0] || null;
        } catch (error) {
          if (isBridgeConnectionError(error)) throw error;
          const result = await rpc('thread/read', { threadId, includeTurns: true });
          turn = result.thread?.turns?.at(-1) || null;
        }
      }
      // Only advance after the full read succeeded, and never retain a late
      // revision after a navigation or transport reset.
      if (conditional && generation === requestGeneration) {
        cached = typeof live?.revision === 'string' ? { threadId, revision: live.revision } : null;
      }
      return { unchanged: false, active: turn?.status === 'inProgress', turn: turn || null };
    },
  };
}
