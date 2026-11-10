export const HISTORY_ITEM_PAGE_SIZE = 80;

// A single research turn can contain thousands of tools. Turn-count paging
// alone does not bound its DOM, so page the items without mutating the record.
export function historyItemWindow(items, limit = HISTORY_ITEM_PAGE_SIZE) {
  const source = Array.isArray(items) ? items : [];
  const count = Number.isFinite(limit) ? Math.max(HISTORY_ITEM_PAGE_SIZE, Math.floor(limit)) : HISTORY_ITEM_PAGE_SIZE;
  const start = Math.max(0, source.length - count);
  return { visible: source.slice(start), hiddenCount: start, limit: count, total: source.length };
}
