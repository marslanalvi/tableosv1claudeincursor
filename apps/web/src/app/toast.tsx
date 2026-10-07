import { create } from "zustand";
import styles from "./ui.module.css";

/**
 * Global toast system (workstream F). Usage from any feature:
 *
 *   import { toast } from "../../app/toast.tsx";
 *   toast.success("Record deleted", { action: { label: "Undo", onClick } });
 *   toast.error(err);            // Error | ApiProblemError | string
 *
 * `<ToastHost />` is mounted once in the root route.
 */
export type ToastKind = "success" | "error" | "info";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
}

interface ToastStore {
  toasts: ToastItem[];
  push(kind: ToastKind, message: string, opts?: { action?: ToastAction; durationMs?: number }): number;
  dismiss(id: number): void;
}

let seq = 0;

export const useToastStore = create<ToastStore>((set, get) => ({
  toasts: [],
  push(kind, message, opts) {
    const existing = get().toasts.find((t) => t.message === message && t.kind === kind);
    if (existing) return existing.id;
    const id = ++seq;
    const item: ToastItem = { id, kind, message };
    if (opts?.action) item.action = opts.action;
    set((s) => ({ toasts: [...s.toasts.slice(-3), item] }));
    const duration = opts?.durationMs ?? (kind === "error" ? 6000 : opts?.action ? 6000 : 3500);
    setTimeout(() => get().dismiss(id), duration);
    return id;
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

/** Human-readable message from anything thrown by `request()`. */
export function errorMessage(err: unknown, fallback = "Something went wrong"): string {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const problem = (err as { problem?: { detail?: string; title?: string } }).problem;
    if (problem?.detail) return problem.detail;
    if (problem?.title) return problem.title;
    const message = (err as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export const toast = {
  success(message: string, opts?: { action?: ToastAction; durationMs?: number }) {
    return useToastStore.getState().push("success", message, opts);
  },
  info(message: string, opts?: { action?: ToastAction; durationMs?: number }) {
    return useToastStore.getState().push("info", message, opts);
  },
  error(err: unknown, fallback?: string) {
    return useToastStore.getState().push("error", errorMessage(err, fallback));
  },
  dismiss(id: number) {
    useToastStore.getState().dismiss(id);
  },
};

export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;
  return (
    <div className={styles.toastStack} role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={styles.toast} data-kind={t.kind}>
          <span className={styles.toastDot} data-kind={t.kind} aria-hidden />
          <span className={styles.toastMessage}>{t.message}</span>
          {t.action ? (
            <button
              type="button"
              className={styles.toastAction}
              onClick={() => {
                t.action?.onClick();
                dismiss(t.id);
              }}
            >
              {t.action.label}
            </button>
          ) : null}
          <button
            type="button"
            className={styles.toastClose}
            aria-label="Dismiss"
            onClick={() => dismiss(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
