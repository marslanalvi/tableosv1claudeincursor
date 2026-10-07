import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fieldTypeIcon, renderCellValue, type FieldLike } from "@tabula/field-ui";
import { commentsApi, relativeTime, type CommentWire } from "../../lib/api-areas/collab.ts";
import {
  errorMessage,
  recordsApi,
  type HistoryChangeWire,
  type HistoryEntryWire,
  type HistoryFieldWire,
} from "../../lib/api-areas/records.ts";
import styles from "./record-activity.module.css";

export type ActivityFilter = "all" | "comments" | "history";

const FILTER_KEY = "tabula.recordActivityFilter";
const FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "All activity",
  comments: "Comments only",
  history: "Revision history only",
};
const MENTION_RE = /@\[([^\]\n]{1,200})\]\((usr_[A-Za-z0-9]+)\)/g;

function readFilter(): ActivityFilter {
  try {
    const v = localStorage.getItem(FILTER_KEY);
    return v === "comments" || v === "history" || v === "all" ? v : "all";
  } catch {
    return "all";
  }
}

export const historyQueryKey = (baseId: string, tableId: string, recordId: string) =>
  ["record", baseId, tableId, recordId, "history"] as const;

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function Time({ iso }: { iso: string }) {
  return (
    <time className={styles.time} dateTime={iso} title={new Date(iso).toLocaleString()}>
      {relativeTime(iso)}
    </time>
  );
}

function actorLabel(e: HistoryEntryWire): string {
  switch (e.source) {
    case "automation":
      return e.sourceName ? `Automation “${e.sourceName}”` : "An automation";
    case "form":
      return "Form submission";
    case "system":
      return e.actor?.name ?? "TableOS";
    default:
      return e.actor?.name ?? "Someone";
  }
}

function verb(e: HistoryEntryWire): string {
  if (e.kind === "created") {
    if (e.source === "form") return "created this record";
    if (e.source === "import") return "imported this record";
    return e.duplicatedFrom ? "created this record by duplicating" : "created this record";
  }
  if (e.kind === "deleted") return "deleted this record";
  if (e.kind === "restored") return e.source === "restore" ? "restored this record from trash" : "restored this record";
  if (!e.detailed && e.changes.length === 0) return e.source === "redo" ? "redid a change" : "reverted a change";
  const n = e.changes.length;
  return n === 1 ? "edited a field" : `edited ${n} fields`;
}

const SOURCE_TAG: Partial<Record<HistoryEntryWire["source"], string>> = {
  automation: "Automation",
  form: "Form",
  import: "Import",
  undo: "Undo",
  redo: "Redo",
  restore: "Trash",
};

function Value({ field, value }: { field: FieldLike; value: unknown }) {
  if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) {
    return <span className={styles.empty}>(empty)</span>;
  }
  return <>{renderCellValue(field, value, { wrap: true })}</>;
}

function ChangeRow({ change, field, meta }: { change: HistoryChangeWire; field: FieldLike | undefined; meta: HistoryFieldWire | undefined }) {
  const f: FieldLike = field ?? {
    id: change.fieldId,
    name: meta?.name ?? "Unknown field",
    type: meta?.type ?? "text",
    config: meta?.config ?? {},
  };
  const deleted = !field;
  return (
    <div className={styles.change} data-testid="history-change" data-field={change.fieldId}>
      <div className={styles.changeField}>
        <span className={styles.fieldIcon}>{fieldTypeIcon(f.type)}</span>
        <span className={deleted ? styles.deletedField : undefined}>{f.name}</span>
        {deleted ? <span className={styles.deletedTag}>deleted field</span> : null}
      </div>
      {"added" in change ? (
        <div className={styles.links}>
          {change.added.map((l) => (
            <span key={`a${l.id}`} className={styles.added} title="Linked">
              + {l.name || "Unnamed record"}
            </span>
          ))}
          {change.removed.map((l) => (
            <span key={`r${l.id}`} className={styles.removed} title="Unlinked">
              − {l.name || "Unnamed record"}
            </span>
          ))}
        </div>
      ) : (
        <div className={styles.diff}>
          <div className={styles.before} aria-label="Previous value">
            <Value field={f} value={change.before} />
          </div>
          <span className={styles.arrow} aria-hidden>
            →
          </span>
          <div className={styles.after} aria-label="New value">
            <Value field={f} value={change.after} />
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryItem({ entry, fields, metas }: { entry: HistoryEntryWire; fields: Map<string, FieldLike>; metas: Record<string, HistoryFieldWire> }) {
  const who = actorLabel(entry);
  const tag = SOURCE_TAG[entry.source];
  return (
    <li className={styles.item} data-testid="history-entry" data-kind={entry.kind}>
      <span className={`${styles.avatar} ${entry.source === "automation" || entry.source === "form" ? styles.avatarBot : ""}`} aria-hidden>
        {entry.source === "automation" ? "⚡" : entry.source === "form" ? "✉" : initials(who)}
      </span>
      <div className={styles.main}>
        <div className={styles.line}>
          <span className={styles.who}>{who}</span> <span className={styles.verb}>{verb(entry)}</span>
          {entry.kind === "created" && entry.duplicatedFrom ? (
            <span className={styles.who}> {entry.duplicatedFrom.name || "a record"}</span>
          ) : null}
          {tag ? <span className={styles.tag}>{tag}</span> : null}
        </div>
        <Time iso={entry.at} />
        {entry.changes.map((c) => (
          <ChangeRow key={c.fieldId} change={c} field={fields.get(c.fieldId)} meta={metas[c.fieldId]} />
        ))}
      </div>
    </li>
  );
}

function renderBody(body: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of body.matchAll(MENTION_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(body.slice(last, start));
    parts.push(
      <span key={i++} className={styles.mention}>
        @{m[1]}
      </span>,
    );
    last = start + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}

function CommentItem({ comment }: { comment: CommentWire }) {
  const name = comment.author?.name ?? comment.authorName ?? "Unknown";
  return (
    <li className={styles.item} data-testid="activity-comment">
      <span className={`${styles.avatar} ${styles.avatarComment}`} aria-hidden>
        {comment.author?.initials ?? initials(name)}
      </span>
      <div className={styles.main}>
        <div className={styles.line}>
          <span className={styles.who}>{name}</span> <span className={styles.verb}>{comment.parentId ? "replied" : "commented"}</span>
          {comment.edited ? <span className={styles.verb}> (edited)</span> : null}
        </div>
        <Time iso={comment.createdAt} />
        <div className={styles.commentBody}>{renderBody(comment.body)}</div>
      </div>
    </li>
  );
}

function QuickComment({ baseId, tableId, recordId, disabled }: { baseId: string; tableId: string; recordId: string; disabled: boolean }) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const send = useMutation({
    mutationFn: (body: string) => commentsApi.create(baseId, tableId, recordId, body),
    onSuccess: () => {
      setText("");
      void qc.invalidateQueries({ queryKey: ["comments", baseId, tableId, recordId] });
    },
  });
  const submit = () => {
    const body = text.trim();
    if (body && !send.isPending) send.mutate(body);
  };
  if (disabled) return null;
  return (
    <div className={styles.composer}>
      <textarea
        className={styles.textarea}
        rows={2}
        value={text}
        placeholder="Leave a comment"
        aria-label="Leave a comment"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className={styles.composerRow}>
        {send.isError ? <span className={styles.error}>{errorMessage(send.error)}</span> : <span className={styles.hint}>Ctrl+Enter to send</span>}
        <button type="button" className={styles.btnPrimary} disabled={!text.trim() || send.isPending} onClick={submit}>
          Comment
        </button>
      </div>
    </div>
  );
}

export interface RecordActivityProps {
  baseId: string;
  tableId: string;
  recordId: string;
  /** Current record version; a change refetches the history (own edits skip realtime). */
  recordVersion?: number | undefined;
  /** Live fields of the table (current names/config win over the history's snapshot). */
  fields: FieldLike[];
  /** Full comments panel (reactions, replies, mentions) for "Comments only". */
  comments: ReactNode;
  canComment?: boolean;
}

/** Drawer side panel: comments + revision history, with Airtable's activity filter. */
export function RecordActivity({ baseId, tableId, recordId, recordVersion, fields, comments, canComment = true }: RecordActivityProps) {
  const qc = useQueryClient();
  const [filter, setFilterState] = useState<ActivityFilter>(readFilter);
  const setFilter = (f: ActivityFilter) => {
    setFilterState(f);
    try {
      localStorage.setItem(FILTER_KEY, f);
    } catch {
      /* private mode */
    }
  };
  const showHistory = filter !== "comments";
  const key = historyQueryKey(baseId, tableId, recordId);
  const history = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => recordsApi.history(baseId, tableId, recordId, { cursor: pageParam, limit: 30 }, signal),
    getNextPageParam: (last) => last?.nextCursor ?? undefined,
    enabled: showHistory,
  });
  const commentsQuery = useQuery({
    queryKey: ["comments", baseId, tableId, recordId],
    queryFn: () => commentsApi.list(baseId, tableId, recordId),
    enabled: filter === "all",
    refetchInterval: 20_000,
  });

  const lastVersion = useRef(recordVersion);
  useEffect(() => {
    if (recordVersion === undefined || recordVersion === lastVersion.current) return;
    lastVersion.current = recordVersion;
    const t = setTimeout(() => void qc.invalidateQueries({ queryKey: key }), 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recordVersion, qc, baseId, tableId, recordId]);

  const fieldMap = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const pages = history.data?.pages ?? [];
  const metas = useMemo(() => Object.assign({}, ...pages.map((p) => p?.fields ?? {})) as Record<string, HistoryFieldWire>, [pages]);
  const entries = useMemo(() => pages.flatMap((p) => p?.entries ?? []), [pages]);
  const retentionDays = pages[0]?.retentionDays ?? null;

  type Item = { at: number; key: string; node: ReactNode };
  const items: Item[] = useMemo(() => {
    const out: Item[] = [];
    if (showHistory) {
      for (const e of entries) {
        out.push({ at: Date.parse(e.at), key: `h${e.id}`, node: <HistoryItem key={`h${e.id}`} entry={e} fields={fieldMap} metas={metas} /> });
      }
    }
    if (filter === "all") {
      // Comments older than the loaded history page would interleave wrongly; hold them until it loads.
      const oldest = history.hasNextPage && entries.length ? Date.parse(entries[entries.length - 1]!.at) : -Infinity;
      for (const c of commentsQuery.data?.comments ?? []) {
        const at = Date.parse(c.createdAt);
        if (at >= oldest) out.push({ at, key: `c${c.id}`, node: <CommentItem key={`c${c.id}`} comment={c} /> });
      }
    }
    return out.sort((a, b) => b.at - a.at);
  }, [showHistory, filter, entries, fieldMap, metas, commentsQuery.data, history.hasNextPage]);

  return (
    <section className={styles.panel} aria-label="Record activity">
      <div className={styles.head}>
        <span className={styles.headTitle}>Activity</span>
        <select
          className={styles.filter}
          aria-label="Show activity"
          value={filter}
          onChange={(e) => setFilter(e.target.value as ActivityFilter)}
        >
          {(Object.keys(FILTER_LABELS) as ActivityFilter[]).map((f) => (
            <option key={f} value={f}>
              {FILTER_LABELS[f]}
            </option>
          ))}
        </select>
      </div>
      {filter === "comments" ? (
        <div className={styles.commentsWrap}>{comments}</div>
      ) : (
        <div className={styles.body}>
          {filter === "all" ? <QuickComment baseId={baseId} tableId={tableId} recordId={recordId} disabled={!canComment} /> : null}
          {history.isError ? <p className={styles.error}>Couldn't load history: {errorMessage(history.error)}</p> : null}
          {history.isLoading ? <p className={styles.note}>Loading activity…</p> : null}
          {!history.isLoading && items.length === 0 ? <p className={styles.note}>No activity yet.</p> : null}
          <ul className={styles.list} data-testid="activity-list">
            {items.map((it) => (
              <Fragment key={it.key}>{it.node}</Fragment>
            ))}
          </ul>
          {history.hasNextPage ? (
            <button type="button" className={styles.more} disabled={history.isFetchingNextPage} onClick={() => void history.fetchNextPage()}>
              {history.isFetchingNextPage ? "Loading…" : "Show older activity"}
            </button>
          ) : retentionDays && entries.length > 0 ? (
            <p className={styles.note}>Revision history is kept for {retentionDays} days on your plan.</p>
          ) : null}
          {filter === "all" ? (
            <button type="button" className={styles.linkBtn} onClick={() => setFilter("comments")}>
              Reply, react or @mention in Comments only
            </button>
          ) : null}
        </div>
      )}
    </section>
  );
}
