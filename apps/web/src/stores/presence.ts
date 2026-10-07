import { create } from "zustand";
import type { RealtimePresenceEntry } from "@tabula/realtime-client";

/**
 * Presence for the open base (workstream F). `peers` is the full list from
 * the server minus this tab's own connection.
 */
interface PresenceState {
  selfConnId: string | null;
  selfUserId: string | null;
  peers: RealtimePresenceEntry[];
  setSelf: (connId: string | null, userId: string | null) => void;
  setPeers: (peers: RealtimePresenceEntry[]) => void;
  reset: () => void;
}

export const usePresenceStore = create<PresenceState>((set, get) => ({
  selfConnId: null,
  selfUserId: null,
  peers: [],
  setSelf: (connId, userId) => {
    set({ selfConnId: connId, selfUserId: userId });
    // Re-filter in case the list arrived before `hello`.
    set({ peers: get().peers.filter((p) => p.connId !== connId) });
  },
  setPeers: (peers) => {
    const self = get().selfConnId;
    set({ peers: peers.filter((p) => p.connId !== self) });
  },
  reset: () => set({ peers: [], selfConnId: null }),
}));

/** Other users in the base, one entry per user (most recently active connection). */
export function useOtherUsers(): RealtimePresenceEntry[] {
  const peers = usePresenceStore((s) => s.peers);
  const selfUserId = usePresenceStore((s) => s.selfUserId);
  const byUser = new Map<string, RealtimePresenceEntry>();
  for (const p of peers) {
    if (selfUserId && p.user.id === selfUserId) continue;
    const prev = byUser.get(p.user.id);
    if (!prev || prev.updatedAt < p.updatedAt) byUser.set(p.user.id, p);
  }
  return [...byUser.values()];
}

/** Peers (any user, other tabs) that have this cell selected — for outlines. */
export function peersOnCell(recordId: string, fieldId: string): RealtimePresenceEntry[] {
  return usePresenceStore
    .getState()
    .peers.filter((p) => p.state.cell?.recordId === recordId && p.state.cell?.fieldId === fieldId);
}
