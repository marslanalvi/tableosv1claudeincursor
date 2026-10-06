import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./grid-view.module.css";

export interface MenuEntry {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  onSelect?: () => void;
  danger?: boolean;
  disabled?: boolean;
  divider?: boolean;
  hint?: string;
}

/** Fixed-position context menu (header, row and summary menus). */
export function Menu({
  x,
  y,
  items,
  onClose,
  minWidth = 240,
}: {
  x: number;
  y: number;
  items: MenuEntry[];
  onClose: () => void;
  minWidth?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: x, top: y });
  const [active, setActive] = useState(-1);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const actionable = items.filter((i) => !i.divider && !i.disabled);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      top: y + h > window.innerHeight - 8 ? Math.max(8, y - h) : y,
    });
    el.focus();
  }, [x, y]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current();
    };
    const onScroll = (e: Event) => {
      if (!ref.current?.contains(e.target as Node)) onCloseRef.current();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onCloseRef.current);
    return () => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onCloseRef.current);
    };
  }, []);

  return (
    <div
      ref={ref}
      className={styles.menu}
      style={{ left: pos.left, top: pos.top, minWidth }}
      role="menu"
      tabIndex={-1}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          setActive((a) => Math.min(actionable.length - 1, a + 1));
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          setActive((a) => Math.max(0, a - 1));
        } else if (e.key === "Enter" && active >= 0) {
          e.preventDefault();
          const item = actionable[active];
          if (item) {
            onClose();
            item.onSelect?.();
          }
        }
      }}
    >
      {items.map((item) =>
        item.divider ? (
          <div key={item.key} className={styles.menuDivider} />
        ) : (
          <button
            key={item.key}
            type="button"
            role="menuitem"
            disabled={item.disabled}
            className={`${styles.menuItem} ${item.danger ? styles.menuDanger : ""} ${
              actionable[active] === item ? styles.menuItemActive : ""
            }`}
            onClick={() => {
              onClose();
              item.onSelect?.();
            }}
          >
            <span className={styles.menuIcon}>{item.icon}</span>
            <span className={styles.menuLabel}>{item.label}</span>
            {item.hint ? <span className={styles.menuHint}>{item.hint}</span> : null}
          </button>
        ),
      )}
    </div>
  );
}

/** Small confirm dialog styled per the design system. */
export function ConfirmDialog({
  title,
  body,
  confirmLabel = "Delete",
  danger = true,
  onConfirm,
  onCancel,
}: {
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const btn = useRef<HTMLButtonElement>(null);
  useEffect(() => btn.current?.focus(), []);
  return (
    <div
      className={styles.dialogBack}
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target === e.currentTarget) onCancel();
      }}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") onCancel();
      }}
    >
      <div className={styles.dialog} role="alertdialog" aria-label={title}>
        <h2 className={styles.dialogTitle}>{title}</h2>
        {body ? <div className={styles.dialogBody}>{body}</div> : null}
        <div className={styles.dialogActions}>
          <button type="button" className={styles.btnSecondary} onClick={onCancel}>
            Cancel
          </button>
          <button
            ref={btn}
            type="button"
            className={danger ? styles.btnDanger : styles.btnPrimary}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
