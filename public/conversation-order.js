// A snapshot supplies native item order, but can lag behind live events. Retain
// items it has not seen yet beside their last known predecessor.
export function mergeTimelineOrder(current, snapshot) {
  const ordered = [...new Set(snapshot)], known = new Set(ordered), extras = new Map();
  let anchor = null;
  for (const item of current) {
    if (known.has(item)) anchor = item;
    else {
      if (!extras.has(anchor)) extras.set(anchor, []);
      extras.get(anchor).push(item);
    }
  }
  return [...(extras.get(null) || []), ...ordered.flatMap(item => [item, ...(extras.get(item) || [])])];
}

export function timelineEvents(stream) {
  return [...stream.children].flatMap(node => node.matches('[data-agent-activity-group]')
    ? [...node.querySelectorAll('.activity-item')] : [node]);
}

export function orderTimeline(stream, snapshot, { createGroup, updateGroup, standalone }) {
  const current = timelineEvents(stream), ordered = mergeTimelineOrder(current, snapshot);
  if (ordered.length === current.length && ordered.every((node, index) => node === current[index])) return;
  const groups = new Set(), blocks = [];
  // Capture outputs before moving any row; each output is the row's sibling.
  const outputs = new Map(current.filter(node => node.matches('.activity-item')).map(row => [row, row.nextElementSibling]));
  let group = null;
  for (const node of ordered) {
    if (!node.matches('.activity-item')) { blocks.push(node); group = null; continue; }
    const single = standalone(node);
    if (!group || single || group.dataset.standalone === 'true') {
      const previous = node.closest('[data-agent-activity-group]');
      group = previous?.dataset.activityGroupAnchor === node.dataset.itemId && !groups.has(previous)
        ? previous : createGroup(node.dataset.itemId, single);
      groups.add(group); blocks.push(group);
    }
    const items = group.querySelector('.activity-items');
    items.append(node);
    const output = outputs.get(node);
    if (output) items.append(output);
    if (single) group = null;
  }
  for (const block of blocks) stream.append(block);
  for (const child of [...stream.children]) if (!blocks.includes(child)) child.remove();
  for (const item of groups) updateGroup(item);
}
