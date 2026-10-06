import { useEffect, useState } from "react";
import { create } from "zustand";

interface Toast {
  id: number;
  message: string;
  kind: "error" | "info";
}

interface ToastState {
  toasts: Toast[];
  push(message: string, kind?: Toast["kind"]): void;
  dismiss(id: number): void;
}

let seq = 0;

export const useToasts = create<ToastState>((set, get) => ({
  toasts: [],
  push(message, kind = "error") {
    const id = ++seq;
    // Collapse identical consecutive messages.
    if (get().toasts.some((t) => t.message === message)) return;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, message, kind }] }));
    setTimeout(() => get().dismiss(id), kind === "error" ? 6000 : 3000);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toastError(message: string): void {
  useToasts.getState().push(message, "error");
}

export function toastInfo(message: string): void {
  useToasts.getState().push(message, "info");
}

let hostSeq = 0;
const useHosts = create<{ hosts: number[] }>(() => ({ hosts: [] }));

/** Renders toasts; safe to mount from several components (only one renders). */
export function Toaster() {
  const toasts = useToasts((s) => s.toasts);
  const dismiss = useToasts((s) => s.dismiss);
  const [myId] = useState(() => ++hostSeq);
  const firstHost = useHosts((s) => s.hosts[0]);
  useEffect(() => {
    useHosts.setState((s) => ({ hosts: [...s.hosts, myId] }));
    return () => useHosts.setState((s) => ({ hosts: s.hosts.filter((h) => h !== myId) }));
  }, [myId]);
  if (firstHost !== myId || toasts.length === 0) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: "fixed",
        bottom: 24,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 2000,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        alignItems: "center",
      }}
    >
      {toasts.map((t) => (
        <div
          key={t.id}
          onClick={() => dismiss(t.id)}
          style={{
            background: "#181d26",
            color: "#fff",
            borderRadius: 10,
            padding: "10px 16px",
            fontSize: 14,
            lineHeight: 1.35,
            maxWidth: 480,
            boxShadow: "0 4px 16px rgba(24,29,38,.18)",
            cursor: "pointer",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          {t.kind === "error" ? <span style={{ color: "#fcab79" }}>●</span> : null}
          {t.message}
        </div>
      ))}
    </div>
  );
}
