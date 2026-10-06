export type WireCellValue = string | number | boolean | string[] | null;

export interface WsTicketResponse {
  ticket: string;
  expiresAt: string;
  url: string;
}

export type RealtimeEventMap = {
  change: RealtimeChangeFrame;
  presence: RealtimePresenceFrame;
  op_ack: RealtimeOpAckFrame;
  op_reject: RealtimeOpRejectFrame;
  resync: RealtimeResyncFrame;
  subscribed: RealtimeSubscribedEvent;
  connected: { connId: string };
  disconnected: { code: number; reason: string };
};

/** Client-facing change hint. All ids are public ids. */
export interface RealtimeChangeFrame {
  type: "change";
  baseId: string;
  seq: number;
  kind?: string;
  tableIds?: string[];
  tableId?: string;
  /** Tables whose record data changed. */
  recordTableIds?: string[];
  recordIds?: string[];
  /** Record data changed (if `recordTableIds` is empty: unknown tables). */
  recordsChanged?: boolean;
  schemaChanged?: boolean;
  clientMutationId?: string | null;
  ops: Array<Record<string, unknown> & { op: string }>;
  actor: { type: "user" | "system"; id: string | null };
}

export interface RealtimePresenceState {
  tableId?: string | null;
  viewId?: string | null;
  recordId?: string | null;
  cell?: { recordId: string; fieldId: string } | null;
  [key: string]: unknown;
}

export interface RealtimePresenceUser {
  id: string;
  name: string;
  email?: string;
}

export interface RealtimePresenceEntry {
  connId: string;
  user: RealtimePresenceUser;
  color: string;
  state: RealtimePresenceState;
  updatedAt: string;
}

/** Full presence snapshot of a base (always the complete list). */
export interface RealtimePresenceFrame {
  type: "presence";
  baseId: string;
  full: true;
  peers: RealtimePresenceEntry[];
}

export interface RealtimeOpAckFrame {
  type: "op_ack";
  clientMutationId: string;
  seq: number;
  version: number;
  recordId?: string;
}

export interface RealtimeOpRejectFrame {
  type: "op_reject";
  clientMutationId: string;
  code: string;
  detail?: string;
}

export interface RealtimeResyncFrame {
  type: "resync_required";
  baseId?: string;
  reason: string;
  headSeq?: number;
}

export interface RealtimeSubscribedEvent {
  baseId: string;
  seq: number;
  /** True when this subscription resumed after a reconnect (catch-up applied). */
  resumed: boolean;
}

export interface CellMutation {
  op: "setCell";
  recordId: string;
  fieldId: string;
  value: WireCellValue;
}

export interface SendOpMutation {
  clientMutationId: string;
  kind: "cells";
  tableId: string;
  ops: CellMutation[];
}

export type RealtimeListener<K extends keyof RealtimeEventMap> = (
  payload: RealtimeEventMap[K],
) => void;
