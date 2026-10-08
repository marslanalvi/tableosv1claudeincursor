import type { DomainEvent } from "@tabula/events";
import { dueSyncIds, runTableSync, type SyncDeps } from "./engine.js";

interface Logger {
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
}

const DEBOUNCE_MS = 2_000;
const SWEEP_MS = 60_000;

/**
 * Keeps synced tables fresh: a source-table change schedules its syncs (after a
 * short debounce so a burst of edits becomes one run), and a periodic sweep
 * runs anything older than its interval.
 */
export function startSyncScheduler(deps: SyncDeps, log: Logger) {
  const running = new Set<string>();
  const again = new Set<string>();
  const timers = new Map<string, NodeJS.Timeout>();

  async function run(syncId: string): Promise<void> {
    if (running.has(syncId)) {
      again.add(syncId);
      return;
    }
    running.add(syncId);
    try {
      const r = await runTableSync(deps, syncId);
      if (r.created || r.updated || r.deleted || r.fieldsChanged) log.info({ syncId, ...r }, "Table sync ran");
    } catch (err) {
      log.warn({ syncId, err: err instanceof Error ? err.message : err }, "Table sync failed");
    } finally {
      running.delete(syncId);
      if (again.delete(syncId)) schedule(syncId);
    }
  }

  function schedule(syncId: string): void {
    clearTimeout(timers.get(syncId));
    timers.set(
      syncId,
      setTimeout(() => {
        timers.delete(syncId);
        void run(syncId);
      }, DEBOUNCE_MS),
    );
  }

  async function onEvent(event: DomainEvent): Promise<void> {
    const data = (event.data ?? {}) as { tableId?: unknown; tableIds?: unknown };
    const ids = new Set<string>();
    if (typeof data.tableId === "string") ids.add(data.tableId);
    if (Array.isArray(data.tableIds)) for (const t of data.tableIds) if (typeof t === "string") ids.add(t);
    if (ids.size === 0) return;
    for (const id of await dueSyncIds(deps.db, [...ids])) schedule(id);
  }

  const sweep = setInterval(() => {
    void dueSyncIds(deps.db)
      .then((ids) => ids.forEach((id) => void run(id)))
      .catch((err) => log.warn({ err }, "Sync sweep failed"));
  }, SWEEP_MS);

  return {
    onEvent,
    stop() {
      clearInterval(sweep);
      for (const t of timers.values()) clearTimeout(t);
    },
  };
}
