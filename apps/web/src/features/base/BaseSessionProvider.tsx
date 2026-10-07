import { RealtimeClient, type RealtimePresenceState } from "@tabula/realtime-client";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, isOwnClientOp } from "../../lib/api.ts";
import { usePresenceStore } from "../../stores/presence.ts";
import { useMe } from "../auth/use-auth.ts";

/**
 * Realtime session for one open base (workstream F).
 *
 * - One WebSocket per provider; the effect depends only on `baseId`, so
 *   renders never reconnect. Reconnects use backoff inside RealtimeClient.
 * - `change` frames invalidate React Query caches per CONTRACTS §7:
 *   `["records", baseId, tableId]`, `["record", baseId, tableId, recordId]`,
 *   and `["bases", baseId]` / `["views", baseId]` for schema changes. Frames
 *   whose `clientMutationId` this tab sent are skipped.
 * - `resync_required` / seq gaps → everything for the base is refetched.
 * - `setPresence({tableId, viewId, recordId, cell})` publishes what this tab
 *   is looking at; other users show in `<PresenceAvatars/>`.
 */
export interface BaseSessionValue {
  baseId: string;
  realtime: RealtimeClient;
  connected: boolean;
  /** Merge into this tab's presence state (ids are public ids). */
  setPresence: (patch: Partial<RealtimePresenceState>) => void;
}

const BaseSessionContext = createContext<BaseSessionValue | null>(null);

export const undoStateKey = (baseId: string) => ["undo-state", baseId] as const;

function invalidateAllForBase(qc: QueryClient, baseId: string): void {
  void qc.invalidateQueries({ queryKey: ["bases", baseId] });
  void qc.invalidateQueries({ queryKey: ["views", baseId] });
  void qc.invalidateQueries({ queryKey: ["records", baseId] });
  void qc.invalidateQueries({ queryKey: ["record", baseId] });
  void qc.invalidateQueries({ queryKey: undoStateKey(baseId) });
}

/** Batches invalidations so a burst of frames triggers one refetch per key. */
function createInvalidator(qc: QueryClient, baseId: string) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const tables = new Set<string>();
  const records = new Set<string>();
  let allRecords = false;
  let schema = false;
  let undo = false;
  const flush = () => {
    timer = null;
    if (schema) {
      void qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["views", baseId] });
    }
    if (allRecords) {
      void qc.invalidateQueries({ queryKey: ["records", baseId] });
      void qc.invalidateQueries({ queryKey: ["record", baseId] });
    } else {
      for (const t of tables) {
        void qc.invalidateQueries({ queryKey: ["records", baseId, t] });
      }
      for (const key of records) {
        const [t, r] = key.split("|");
        void qc.invalidateQueries({ queryKey: ["record", baseId, t, r] });
      }
    }
    if (undo) void qc.invalidateQueries({ queryKey: undoStateKey(baseId) });
    tables.clear();
    records.clear();
    allRecords = false;
    schema = false;
    undo = false;
  };
  const schedule = () => {
    if (!timer) timer = setTimeout(flush, 40);
  };
  return {
    records(tableIds: string[], recordIds: string[], unknownTables: boolean) {
      if (unknownTables || tableIds.length !== 1) {
        // Without a single table we cannot pair record ids with tables.
        if (unknownTables) allRecords = true;
        for (const t of tableIds) tables.add(t);
        if (recordIds.length > 0) {
          void qc.invalidateQueries({
            predicate: (q) =>
              q.queryKey[0] === "record" &&
              q.queryKey[1] === baseId &&
              recordIds.includes(String(q.queryKey[3])),
          });
        }
      } else {
        const t = tableIds[0]!;
        tables.add(t);
        for (const r of recordIds) records.add(`${t}|${r}`);
      }
      schedule();
    },
    schema() {
      schema = true;
      schedule();
    },
    undo() {
      undo = true;
      schedule();
    },
    cancel() {
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

export function BaseSessionProvider({
  baseId,
  children,
  onResync,
}: {
  baseId: string;
  children: ReactNode;
  onResync?: () => void;
}) {
  const queryClient = useQueryClient();
  const me = useMe();
  const realtimeRef = useRef<RealtimeClient | null>(null);
  const [connected, setConnected] = useState(false);
  const onResyncRef = useRef(onResync);
  onResyncRef.current = onResync;
  const presenceRef = useRef<RealtimePresenceState>({});
  const meIdRef = useRef<string | null>(null);
  meIdRef.current = me.data?.id ?? null;

  if (!realtimeRef.current) {
    realtimeRef.current = new RealtimeClient({
      getTicket: async () => {
        const t = await api.wsTicket();
        return { ticket: t.ticket, url: t.url ?? "/ws" };
      },
    });
  }
  const realtime = realtimeRef.current;

  useEffect(() => {
    usePresenceStore.getState().setSelf(
      usePresenceStore.getState().selfConnId,
      me.data?.id ?? null,
    );
  }, [me.data?.id]);

  useEffect(() => {
    const presence = usePresenceStore.getState();
    presence.reset();
    const inv = createInvalidator(queryClient, baseId);

    const resync = () => {
      invalidateAllForBase(queryClient, baseId);
      onResyncRef.current?.();
    };

    const offs = [
      realtime.on("connected", ({ connId }) => {
        setConnected(true);
        usePresenceStore.getState().setSelf(connId || null, meIdRef.current);
      }),
      realtime.on("disconnected", () => setConnected(false)),
      realtime.on("subscribed", ({ resumed }) => {
        // After a reconnect the server replays missed changes; refetching
        // once more covers anything that happened during the gap.
        if (resumed) resync();
      }),
      realtime.on("change", (frame) => {
        const own = isOwnClientOp(frame.clientMutationId);
        if (frame.kind === "undo" || frame.kind === "redo" || own) inv.undo();
        if (own) return;
        if (frame.actor.type === "user" && frame.actor.id === meIdRef.current) inv.undo();
        if (frame.schemaChanged) inv.schema();
        const tables = frame.recordTableIds ?? [];
        if (frame.recordsChanged || tables.length > 0) {
          inv.records(tables, frame.recordIds ?? [], tables.length === 0);
        }
      }),
      realtime.on("presence", (frame) => {
        usePresenceStore.getState().setPeers(frame.peers);
      }),
      realtime.on("resync", () => resync()),
    ];

    realtime.subscribeBase(baseId);
    void realtime.connect();

    // Track the open record (`?record=` is managed by the table page).
    let lastRecord: string | null = null;
    const recordPoll = setInterval(() => {
      const rec = new URL(window.location.href).searchParams.get("record");
      if (rec !== lastRecord) {
        lastRecord = rec;
        presenceRef.current = { ...presenceRef.current, recordId: rec };
        realtime.setPresence(presenceRef.current);
      }
    }, 1000);

    return () => {
      clearInterval(recordPoll);
      inv.cancel();
      for (const off of offs) off();
      realtime.disconnect();
      usePresenceStore.getState().reset();
      setConnected(false);
    };
  }, [baseId, queryClient, realtime]);

  const setPresence = useCallback(
    (patch: Partial<RealtimePresenceState>) => {
      const next = { ...presenceRef.current, ...patch };
      if (JSON.stringify(next) === JSON.stringify(presenceRef.current)) return;
      presenceRef.current = next;
      realtime.setPresence(next);
    },
    [realtime],
  );

  const value = useMemo(
    (): BaseSessionValue => ({ baseId, realtime, connected, setPresence }),
    [baseId, realtime, connected, setPresence],
  );

  return (
    <BaseSessionContext.Provider value={value}>{children}</BaseSessionContext.Provider>
  );
}

export function useBaseSession(): BaseSessionValue {
  const ctx = useContext(BaseSessionContext);
  if (!ctx) {
    throw new Error("useBaseSession requires BaseSessionProvider");
  }
  return ctx;
}

/** Same as useBaseSession but returns null outside a base (safe for shared components). */
export function useOptionalBaseSession(): BaseSessionValue | null {
  return useContext(BaseSessionContext);
}
