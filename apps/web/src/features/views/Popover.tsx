import { useEffect, useRef, type ReactNode } from "react";
import styles from "./views.module.css";

/** Anchored panel that closes on Escape or a click outside (anchor excluded). */
export function Popover({
  open,
  onClose,
  anchorRef,
  children,
  align = "left",
  width,
  label,
}: {
  open: boolean;
  onClose: () => void;
  anchorRef?: React.RefObject<HTMLElement | null>;
  children: ReactNode;
  align?: "left" | "right";
  width?: number;
  label?: string;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      // Ignore clicks inside nested portals/popovers rendered by field editors.
      if ((t as Element).closest?.("[data-popover-keep]")) return;
      onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      // If focus sits in a nested overlay (e.g. a field editor's option list
      // rendered outside this panel), let that overlay handle Escape first.
      const active = document.activeElement;
      if (
        active &&
        active !== document.body &&
        !ref.current?.contains(active) &&
        !anchorRef?.current?.contains(active)
      ) {
        return;
      }
      onClose();
    }
    document.addEventListener("mousedown", onDown);
    // Capture phase: nested editors may stop propagation of Escape.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [open, onClose, anchorRef]);
  if (!open) return null;
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={styles.popover}
      style={{ [align]: 0, ...(width ? { width } : {}) }}
    >
      {children}
    </div>
  );
}
