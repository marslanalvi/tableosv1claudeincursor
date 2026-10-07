import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import styles from "./ui.module.css";

/**
 * Shell UI primitives (workstream F): Dialog, ConfirmDialog, PromptDialog,
 * DropdownMenu, Avatar. Other workstreams may import these.
 */
export { styles as uiStyles };

export function Dialog({
  title,
  onClose,
  children,
  footer,
  wide,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      className={styles.backdrop}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={wide ? `${styles.dialog} ${styles.dialogWide}` : styles.dialog}
        role="dialog"
        aria-modal="true"
      >
        <div className={styles.dialogHeader}>
          <h2 className={styles.dialogTitle}>{title}</h2>
          <button type="button" className={styles.iconBtn} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className={styles.dialogBody}>{children}</div>
        {footer ? <div className={styles.dialogFooter}>{footer}</div> : null}
      </div>
    </div>
  );
}

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "Delete",
  danger = true,
  busy,
  onConfirm,
  onClose,
}: {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={danger ? styles.btnDanger : styles.btnPrimary}
            disabled={busy}
            autoFocus
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div>{message}</div>
    </Dialog>
  );
}

export function PromptDialog({
  title,
  label,
  initialValue = "",
  confirmLabel = "Save",
  busy,
  error,
  onSubmit,
  onClose,
  children,
}: {
  title: string;
  label: string;
  initialValue?: string;
  confirmLabel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (value: string) => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.select();
  }, []);
  const submit = () => {
    const v = value.trim();
    if (v) onSubmit(v);
  };
  return (
    <Dialog
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={styles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={styles.btnPrimary}
            disabled={busy || !value.trim()}
            onClick={submit}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <div className={styles.field}>
          <label className={styles.label}>
            {label}
            <input
              ref={inputRef}
              className={styles.input}
              style={{ marginTop: 6 }}
              value={value}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        </div>
        {children}
        {error ? <p className={styles.error}>{error}</p> : null}
      </form>
    </Dialog>
  );
}

export interface MenuItemSpec {
  key: string;
  label: ReactNode;
  icon?: ReactNode;
  hint?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  onSelect?: () => void;
  /** Render a separator before this item. */
  separatorBefore?: boolean;
  /** A non-interactive section label. */
  heading?: boolean;
}

/** Click-to-open dropdown; closes on outside click / Escape / selection. */
export function DropdownMenu({
  trigger,
  items,
  align = "left",
  open: openProp,
  onOpenChange,
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  items: MenuItemSpec[];
  align?: "left" | "right";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [openState, setOpenState] = useState(false);
  const open = openProp ?? openState;
  const setOpen = (v: boolean) => {
    setOpenState(v);
    onOpenChange?.(v);
  };
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  return (
    <div className={styles.menuAnchor} ref={ref}>
      {trigger({ open, toggle: () => setOpen(!open) })}
      {open ? (
        <div
          className={align === "right" ? `${styles.menu} ${styles.menuRight}` : styles.menu}
          role="menu"
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore ? <div className={styles.menuSep} /> : null}
              {item.heading ? (
                <div className={styles.menuLabel}>{item.label}</div>
              ) : (
                <button
                  type="button"
                  role="menuitem"
                  disabled={item.disabled}
                  className={
                    item.danger ? `${styles.menuItem} ${styles.menuItemDanger}` : styles.menuItem
                  }
                  onClick={() => {
                    setOpen(false);
                    item.onSelect?.();
                  }}
                >
                  {item.icon !== undefined ? (
                    <span className={styles.menuIcon} aria-hidden>
                      {item.icon}
                    </span>
                  ) : null}
                  <span>{item.label}</span>
                  {item.hint ? <span className={styles.menuHint}>{item.hint}</span> : null}
                </button>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function initials(name: string): string {
  return (
    name
      .split(/[\s@._-]+/)
      .filter(Boolean)
      .map((p) => p[0])
      .join("")
      .slice(0, 2)
      .toUpperCase() || "?"
  );
}

const AVATAR_COLORS = ["#181d26", "#aa2d00", "#0a2e0e", "#254fad", "#7c5a12", "#5b3b8c"];

export function colorFor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length] ?? "#181d26";
}

export function Avatar({
  name,
  id,
  color,
  size = 28,
  title,
}: {
  name: string;
  id?: string;
  color?: string;
  size?: number;
  title?: string;
}) {
  return (
    <span
      className={styles.avatar}
      title={title ?? name}
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: color ?? colorFor(id ?? name),
      }}
    >
      {initials(name)}
    </span>
  );
}

/** True when keyboard focus is in a text-editing control. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag === "INPUT") {
    const type = (target as HTMLInputElement).type;
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(type);
  }
  return false;
}
