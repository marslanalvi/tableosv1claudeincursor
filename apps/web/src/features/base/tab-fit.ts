/**
 * Which table tabs fit in `available` px (Airtable-style): tabs fill the bar in
 * order; the rest go to the overflow menu. The active tab is always shown —
 * when it would overflow it takes the last visible slot.
 */
export function fitTabs(
  ids: string[],
  widths: Record<string, number>,
  available: number,
  activeId: string | null,
): { shown: string[]; overflow: string[] } {
  const w = (id: string) => widths[id] ?? 0;
  const shown: string[] = [];
  let used = 0;
  for (const id of ids) {
    if (used + w(id) > available) break;
    shown.push(id);
    used += w(id);
  }
  if (activeId && ids.includes(activeId) && !shown.includes(activeId)) {
    while (shown.length && used + w(activeId) > available) used -= w(shown.pop()!);
    shown.push(activeId);
  }
  if (!shown.length && ids.length) shown.push(activeId && ids.includes(activeId) ? activeId : ids[0]!);
  const set = new Set(shown);
  return {
    shown: ids.filter((id) => set.has(id)),
    overflow: ids.filter((id) => !set.has(id)),
  };
}

/** Full order after dropping `dragId` before `beforeId` (null = after `afterId`, or at the end). */
export function moveId(order: string[], dragId: string, beforeId: string | null, afterId?: string | null): string[] {
  const ids = order.filter((id) => id !== dragId);
  if (beforeId && beforeId !== dragId) {
    ids.splice(ids.indexOf(beforeId), 0, dragId);
  } else if (afterId && afterId !== dragId) {
    ids.splice(ids.indexOf(afterId) + 1, 0, dragId);
  } else if (beforeId === dragId || afterId === dragId) {
    return order;
  } else {
    ids.push(dragId);
  }
  return ids;
}
