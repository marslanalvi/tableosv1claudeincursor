import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { searchAll, type SearchResult } from "../../lib/api-areas/search.ts";
import styles from "./search-palette.module.css";

const KIND_LABEL: Record<SearchResult["kind"], string> = {
  base: "Bases",
  table: "Tables",
  record: "Records",
};

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

function Highlight({ text, q }: { text: string; q: string }) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className={styles.mark}>{text.slice(i, i + q.length)}</mark>
      {text.slice(i + q.length)}
    </>
  );
}

/** Cmd/Ctrl+K palette: bases, tables and records across the user's workspaces. */
/**
 * Navigate to an in-app link such as `/bases/bas_…?table=tbl_…&record=rec_…`.
 * The record drawer reads `?record=` on mount and on popstate, so a popstate is
 * dispatched for links into the base that is already open.
 */
export async function navigateToLink(router: { navigate: (opts: { href: string }) => Promise<void> }, href: string) {
  await router.navigate({ href });
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

export function SearchPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [q, setQ] = useState("");
  const [active, setActive] = useState(0);
  const router = useRouter();
  const listRef = useRef<HTMLUListElement>(null);
  const debounced = useDebounced(q.trim(), 150);

  useEffect(() => {
    if (!open) setQ("");
    setActive(0);
  }, [open]);

  const searchQuery = useQuery({
    queryKey: ["search", debounced],
    queryFn: ({ signal }) => searchAll(debounced, { signal }),
    enabled: open && debounced.length > 0,
    staleTime: 10_000,
  });
  const results = useMemo(() => searchQuery.data?.results ?? [], [searchQuery.data]);

  useEffect(() => setActive(0), [results]);

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function go(r: SearchResult) {
    onClose();
    void navigateToLink(router, r.href);
  }

  const grouped: { kind: SearchResult["kind"]; items: { r: SearchResult; index: number }[] }[] = [];
  results.forEach((r, index) => {
    let g = grouped.find((x) => x.kind === r.kind);
    if (!g) {
      g = { kind: r.kind, items: [] };
      grouped.push(g);
    }
    g.items.push({ r, index });
  });
  const ordered = grouped.flatMap((g) => g.items);

  return (
    <div className={styles.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        className={styles.panel}
        role="dialog"
        aria-modal="true"
        aria-label="Search"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={styles.inputRow}>
          <span className={styles.searchIcon} aria-hidden>
            ⌕
          </span>
          <input
            autoFocus
            className={styles.input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search bases, tables and records"
            aria-label="Search"
            role="combobox"
            aria-expanded={results.length > 0}
            aria-controls="search-results"
            aria-activedescendant={ordered[active] ? `search-r-${ordered[active].index}` : undefined}
            onKeyDown={(e) => {
              if (e.key === "Escape") onClose();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, Math.max(ordered.length - 1, 0)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                const hit = ordered[active];
                if (hit) go(hit.r);
              }
            }}
          />
          <kbd className={styles.kbd}>Esc</kbd>
        </div>
        <ul className={styles.results} id="search-results" role="listbox" ref={listRef}>
          {grouped.map((g) => (
            <li key={g.kind} role="presentation">
              <div className={styles.group}>{KIND_LABEL[g.kind]}</div>
              <ul role="presentation" className={styles.groupList}>
                {g.items.map(({ r }) => {
                  const pos = ordered.findIndex((o) => o.r === r);
                  return (
                    <li
                      key={`${r.kind}-${r.id}`}
                      id={`search-r-${ordered[pos]?.index}`}
                      role="option"
                      aria-selected={pos === active}
                      data-index={pos}
                      className={pos === active ? styles.resultActive : styles.result}
                      onMouseEnter={() => setActive(pos)}
                      onClick={() => go(r)}
                    >
                      <span className={styles.kind} data-kind={r.kind} aria-hidden>
                        {r.kind === "base" ? "B" : r.kind === "table" ? "T" : "R"}
                      </span>
                      <span className={styles.text}>
                        <span className={styles.title}>
                          <Highlight text={r.title} q={debounced} />
                        </span>
                        {r.subtitle ? <span className={styles.subtitle}>{r.subtitle}</span> : null}
                      </span>
                      {pos === active ? <span className={styles.enter} aria-hidden>↵</span> : null}
                    </li>
                  );
                })}
              </ul>
            </li>
          ))}
          {debounced && searchQuery.isFetching && results.length === 0 ? (
            <li className={styles.empty}>Searching…</li>
          ) : null}
          {debounced && searchQuery.isSuccess && results.length === 0 ? (
            <li className={styles.empty}>No results for “{debounced}”</li>
          ) : null}
          {searchQuery.isError ? <li className={styles.empty}>Search failed. Try again.</li> : null}
          {!debounced ? (
            <li className={styles.empty}>Type to search everything you have access to.</li>
          ) : null}
        </ul>
        <div className={styles.footer}>
          <span>
            <kbd className={styles.kbd}>↑</kbd> <kbd className={styles.kbd}>↓</kbd> to navigate
          </span>
          <span>
            <kbd className={styles.kbd}>↵</kbd> to open
          </span>
        </div>
      </div>
    </div>
  );
}

export function useSearchPaletteShortcut(onOpen: () => void) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);
}
