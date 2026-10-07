import { useEffect, useMemo, useRef, useState } from "react";
import type { TokenOption } from "./catalog.ts";
import styles from "./automations.module.css";

/**
 * Text input (or textarea) with a "+" token picker that inserts
 * `{{trigger.record.fields.Name}}`-style tokens at the caret.
 */
export function TokenInput({
  value,
  onChange,
  tokens,
  placeholder,
  multiline = false,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  tokens: TokenOption[];
  placeholder?: string;
  multiline?: boolean;
  ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const caret = useRef<number | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, TokenOption[]>();
    for (const t of tokens) {
      if (q && !`${t.group} ${t.label}`.toLowerCase().includes(q)) continue;
      const list = m.get(t.group) ?? [];
      list.push(t);
      m.set(t.group, list);
    }
    return [...m.entries()];
  }, [tokens, query]);

  const insert = (token: string) => {
    const pos = caret.current ?? value.length;
    const next = value.slice(0, pos) + token + value.slice(pos);
    onChange(next);
    setOpen(false);
    setQuery("");
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        const p = pos + token.length;
        el.setSelectionRange(p, p);
      }
    });
  };

  const common = {
    ref,
    value,
    placeholder,
    "aria-label": ariaLabel,
    className: multiline ? styles.textarea : styles.input,
    onChange: (e: { target: { value: string; selectionStart: number | null } }) => {
      caret.current = e.target.selectionStart;
      onChange(e.target.value);
    },
    onSelect: (e: { currentTarget: { selectionStart: number | null } }) => {
      caret.current = e.currentTarget.selectionStart;
    },
    onBlur: (e: { currentTarget: { selectionStart: number | null } }) => {
      caret.current = e.currentTarget.selectionStart;
    },
  };

  return (
    <div className={styles.tokenWrap} ref={wrapRef}>
      {multiline ? <textarea rows={4} {...common} /> : <input type="text" {...common} />}
      <button
        type="button"
        className={styles.tokenBtn}
        title="Insert a value from an earlier step"
        aria-label="Insert dynamic value"
        onClick={() => setOpen((o) => !o)}
      >
        +
      </button>
      {open ? (
        <div className={styles.tokenMenu} role="listbox">
          <input
            autoFocus
            className={styles.input}
            placeholder="Find a value"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {groups.length === 0 ? <p className={styles.muted}>No matching values</p> : null}
          {groups.map(([group, items]) => (
            <div key={group} className={styles.tokenGroup}>
              <div className={styles.tokenGroupLabel}>{group}</div>
              {items.map((t) => (
                <button key={t.token + t.label} type="button" role="option" onClick={() => insert(t.token)}>
                  {t.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
