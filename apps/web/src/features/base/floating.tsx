import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { computeFloatingPosition, type FloatingPosition, type Placement } from "./floating-position.ts";

export type { Placement };

/**
 * Viewport-aware popup rendered in a portal (so overflow:hidden parents never
 * clip it). Closes on outside mousedown and Escape. Clicks inside nested
 * FloatingPanels (rendered as React children) count as inside.
 */
export function FloatingPanel({
  anchorRef,
  onClose,
  placement = "bottom-start",
  children,
  className,
  style,
  role,
  ariaLabel,
  id,
  restoreFocus = true,
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  placement?: Placement;
  children: ReactNode;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  role?: string | undefined;
  ariaLabel?: string | undefined;
  id?: string | undefined;
  restoreFocus?: boolean;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  const insideRef = useRef(false);
  const [pos, setPos] = useState<FloatingPosition | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const place = useCallback(() => {
    const anchor = anchorRef.current;
    const el = ref.current;
    if (!anchor || !el) return;
    const a = anchor.getBoundingClientRect();
    const prevMax = el.style.maxHeight;
    el.style.maxHeight = "none";
    const size = { width: el.offsetWidth, height: el.scrollHeight };
    el.style.maxHeight = prevMax;
    const next = computeFloatingPosition(a, size, placement, {
      width: document.documentElement.clientWidth,
      height: document.documentElement.clientHeight,
    });
    setPos((p) =>
      p && p.left === next.left && p.top === next.top && p.maxHeight === next.maxHeight ? p : next,
    );
  }, [anchorRef, placement]);

  useLayoutEffect(() => {
    place();
  });

  useEffect(() => {
    const el = ref.current;
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => place()) : null;
    if (el && ro) ro.observe(el);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [place]);

  useEffect(() => {
    const anchor = anchorRef.current;
    const onDown = (e: MouseEvent) => {
      const inside = insideRef.current;
      insideRef.current = false;
      if (inside) return;
      if (anchor?.contains(e.target as Node)) return;
      onCloseRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body && !anchor?.contains(active)) return;
      onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [anchorRef]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role={role}
      aria-label={ariaLabel}
      className={className}
      data-floating-panel=""
      style={{
        position: "fixed",
        zIndex: 950,
        left: pos?.left ?? 0,
        top: pos?.top ?? 0,
        maxHeight: pos?.maxHeight,
        // opacity, not visibility: children may focus themselves on mount
        opacity: pos ? 1 : 0,
        boxSizing: "border-box",
        ...style,
      }}
      onMouseDownCapture={() => {
        insideRef.current = true;
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose();
          if (restoreFocus) anchorRef.current?.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}
