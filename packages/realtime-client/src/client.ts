import { fetchWsTicket, resolveWsUrl } from "./ticket.js";
import type {
  RealtimeChangeFrame,
  RealtimeEventMap,
  RealtimeListener,
  RealtimeOpAckFrame,
  RealtimeOpRejectFrame,
  RealtimePresenceFrame,
  RealtimePresenceState,
  RealtimeResyncFrame,
  SendOpMutation,
} from "./types.js";

export interface RealtimeClientOptions {
  apiBase?: string;
  /** Override ticket fetch (testing). */
  getTicket?: () => Promise<{ ticket: string; url: string }>;
  maxBackoffMs?: number;
  /** Presence heartbeat interval (server drops entries after ~90s). */
  presenceHeartbeatMs?: number;
}

type Frame =
  | RealtimeChangeFrame
  | RealtimePresenceFrame
  | RealtimeOpAckFrame
  | RealtimeOpRejectFrame
  | RealtimeResyncFrame
  | { type: string; [key: string]: unknown };

/**
 * One WebSocket per client instance, subscribed to at most one base.
 *
 * - Subscribes exactly once per socket (on `hello`), resuming from the last
 *   seen seq after a reconnect so the server can replay missed changes or
 *   answer `resync_required`.
 * - Reconnects with exponential backoff + jitter; `disconnect()` cancels any
 *   in-flight connect so no orphan sockets are left behind.
 * - Detects seq gaps in the live stream and emits `resync`.
 */
export class RealtimeClient {
  private readonly apiBase: string;
  private readonly getTicket: () => Promise<{ ticket: string; url: string }>;
  private readonly maxBackoffMs: number;
  private readonly presenceHeartbeatMs: number;
  private socket: WebSocket | null = null;
  private listeners: {
    [K in keyof RealtimeEventMap]?: Set<RealtimeListener<K>>;
  } = {};
  private subscribedBaseId: string | null = null;
  /** Last seq applied for `subscribedBaseId` (0 = unknown / fresh). */
  private afterSeq = 0;
  private reconnectAttempt = 0;
  private closedByUser = true;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private presenceTimer: ReturnType<typeof setInterval> | null = null;
  private presenceState: RealtimePresenceState | null = null;
  /** Bumped on every connect/disconnect; stale async opens bail out. */
  private generation = 0;
  private ready = false;

  constructor(options: RealtimeClientOptions = {}) {
    this.apiBase = options.apiBase ?? "";
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000;
    this.presenceHeartbeatMs = options.presenceHeartbeatMs ?? 30_000;
    this.getTicket =
      options.getTicket ??
      (async () => {
        const t = await fetchWsTicket(this.apiBase);
        return { ticket: t.ticket, url: t.url };
      });
  }

  on<K extends keyof RealtimeEventMap>(
    event: K,
    listener: RealtimeListener<K>,
  ): () => void {
    const set =
      (this.listeners[event] as Set<RealtimeListener<K>> | undefined) ??
      new Set<RealtimeListener<K>>();
    set.add(listener);
    this.listeners[event] = set as (typeof this.listeners)[K];
    return () => {
      set.delete(listener);
    };
  }

  get isConnected(): boolean {
    return this.ready;
  }

  getAfterSeq(): number {
    return this.afterSeq;
  }

  setAfterSeq(seq: number): void {
    this.afterSeq = seq;
  }

  /** Open the socket (idempotent while already connected/connecting). */
  async connect(): Promise<void> {
    if (!this.closedByUser) return;
    this.closedByUser = false;
    this.generation += 1;
    await this.openSocket(this.generation);
  }

  disconnect(): void {
    this.closedByUser = true;
    this.generation += 1;
    this.ready = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopPresenceHeartbeat();
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState <= WebSocket.OPEN) {
      socket.close(1000, "client disconnect");
    }
  }

  /**
   * Select the base to follow. Sends `subscribe` now if the socket is ready;
   * otherwise it is sent once on `hello`. Never sends twice per socket.
   */
  subscribeBase(baseId: string, sinceSeq?: number): void {
    if (this.subscribedBaseId !== baseId) {
      if (this.subscribedBaseId && this.ready) {
        this.send({ type: "unsubscribe", baseId: this.subscribedBaseId });
      }
      this.subscribedBaseId = baseId;
      this.afterSeq = sinceSeq ?? 0;
      if (this.ready) this.sendSubscribe();
    } else if (sinceSeq !== undefined) {
      this.afterSeq = sinceSeq;
    }
  }

  /** Publish what this client is looking at; re-sent on reconnect. */
  setPresence(state: RealtimePresenceState): void {
    this.presenceState = state;
    this.sendPresence();
  }

  sendOp(baseId: string, _schemaVersion: number, mutations: SendOpMutation[]): void {
    for (const mutation of mutations) {
      for (const cellOp of mutation.ops) {
        this.send({
          type: "op",
          baseId,
          tableId: mutation.tableId,
          recordId: cellOp.recordId,
          fieldId: cellOp.fieldId,
          value: cellOp.value,
          clientMutationId: mutation.clientMutationId,
        });
      }
    }
  }

  private sendSubscribe(): void {
    if (!this.subscribedBaseId) return;
    this.send({
      type: "subscribe",
      baseId: this.subscribedBaseId,
      ...(this.afterSeq > 0 ? { afterSeq: this.afterSeq } : {}),
    });
  }

  private sendPresence(): void {
    if (!this.ready || !this.subscribedBaseId || !this.presenceState) return;
    this.send({
      type: "presence",
      baseId: this.subscribedBaseId,
      state: this.presenceState,
    });
  }

  private startPresenceHeartbeat(): void {
    this.stopPresenceHeartbeat();
    this.presenceTimer = setInterval(() => {
      this.sendPresence();
    }, this.presenceHeartbeatMs);
  }

  private stopPresenceHeartbeat(): void {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
  }

  private emit<K extends keyof RealtimeEventMap>(
    event: K,
    payload: RealtimeEventMap[K],
  ): void {
    const set = this.listeners[event];
    if (!set) return;
    for (const fn of set) {
      try {
        fn(payload);
      } catch (err) {
        console.error("[realtime] listener failed", err);
      }
    }
  }

  private send(payload: Record<string, unknown>): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(payload));
  }

  private scheduleReconnect(generation: number): void {
    if (this.closedByUser || generation !== this.generation) return;
    if (this.reconnectTimer) return;
    const base = Math.min(1000 * 2 ** this.reconnectAttempt, this.maxBackoffMs);
    const delay = Math.round(base * (0.75 + Math.random() * 0.5));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (generation !== this.generation || this.closedByUser) return;
      void this.openSocket(generation);
    }, delay);
  }

  private async openSocket(generation: number): Promise<void> {
    let ticket: string;
    let url: string;
    try {
      ({ ticket, url } = await this.getTicket());
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    // disconnect() (or a newer connect) happened while fetching the ticket.
    if (generation !== this.generation || this.closedByUser) return;

    let socket: WebSocket;
    try {
      const wsUrl = resolveWsUrl(url, globalThis.location);
      const sep = wsUrl.includes("?") ? "&" : "?";
      const fullUrl = `${wsUrl}${sep}ticket=${encodeURIComponent(ticket)}`;
      socket = new WebSocket(fullUrl, "tabula.v1");
    } catch {
      this.scheduleReconnect(generation);
      return;
    }
    this.socket = socket;

    socket.addEventListener("message", (ev) => {
      if (this.socket !== socket) return;
      this.handleMessage(String(ev.data));
    });

    socket.addEventListener("close", (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.ready = false;
      this.stopPresenceHeartbeat();
      this.emit("disconnected", { code: ev.code, reason: ev.reason });
      this.scheduleReconnect(generation);
    });

    socket.addEventListener("error", () => {
      /* close handler runs reconnect */
    });
  }

  private handleMessage(raw: string): void {
    let frame: Frame;
    try {
      frame = JSON.parse(raw) as Frame;
    } catch {
      return;
    }

    switch (frame.type) {
      case "hello":
      case "authed": {
        if (this.ready) break;
        this.ready = true;
        this.reconnectAttempt = 0;
        const connId = String((frame as { connId?: string }).connId ?? "");
        this.emit("connected", { connId });
        this.sendSubscribe();
        this.startPresenceHeartbeat();
        break;
      }
      case "subscribed": {
        const f = frame as unknown as { baseId: string; seq: number };
        const resumed = this.afterSeq > 0;
        if (!resumed) this.afterSeq = f.seq;
        this.emit("subscribed", { baseId: f.baseId, seq: f.seq, resumed });
        this.sendPresence();
        break;
      }
      case "change": {
        const change = frame as RealtimeChangeFrame;
        if (this.afterSeq > 0 && change.seq <= this.afterSeq) break; // dup
        const gap = this.afterSeq > 0 && change.seq > this.afterSeq + 1;
        this.afterSeq = change.seq;
        if (gap) {
          this.emit("resync", {
            type: "resync_required",
            reason: "client_gap",
            headSeq: change.seq,
          });
        }
        this.emit("change", change);
        break;
      }
      case "presence":
        this.emit("presence", frame as RealtimePresenceFrame);
        break;
      case "op_ack": {
        const ack = frame as RealtimeOpAckFrame;
        this.emit("op_ack", ack);
        break;
      }
      case "op_reject":
        this.emit("op_reject", frame as RealtimeOpRejectFrame);
        break;
      case "resync_required": {
        const r = frame as RealtimeResyncFrame;
        if (typeof r.headSeq === "number") this.afterSeq = r.headSeq;
        this.emit("resync", r);
        break;
      }
      default:
        break;
    }
  }
}
