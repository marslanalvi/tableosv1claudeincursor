import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useMemo, useRef, useState, type ReactNode } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import {
  commentsApi,
  listCollaborators,
  relativeTime,
  type Collaborator,
  type CommentWire,
} from "../../lib/api-areas/collab.ts";
import styles from "./comments.module.css";

const REACTIONS = ["👍", "❤️", "😄", "🎉", "👀", "✅"];
const MARKUP_RE = /@\[([^\]\n]{1,200})\]\((usr_[A-Za-z0-9]+)\)/g;
const AVATAR_COLORS = [
  "var(--tabula-color-signature-peach)",
  "var(--tabula-color-signature-mint)",
  "var(--tabula-color-signature-yellow)",
  "var(--tabula-color-signature-cream)",
  "var(--tabula-color-signature-mustard)",
];

function colorFor(id: string): string {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length]!;
}

function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "?"
  );
}

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) return err.problem.detail ?? err.problem.title;
  return err instanceof Error ? err.message : "Something went wrong";
}

/** Render a body: mention markup → chips, keep line breaks. */
function renderBody(body: string): ReactNode {
  const parts: ReactNode[] = [];
  let last = 0;
  let i = 0;
  for (const m of body.matchAll(MARKUP_RE)) {
    const start = m.index ?? 0;
    if (start > last) parts.push(body.slice(last, start));
    parts.push(
      <span key={`m${i++}`} className={styles.mention} title={m[2]}>
        @{m[1]}
      </span>,
    );
    last = start + m[0].length;
  }
  if (last < body.length) parts.push(body.slice(last));
  return parts;
}

/** Composer text uses `@Name`; convert known mentions to markup on send. */
function toMarkup(text: string, mentioned: Map<string, string>): string {
  let out = text;
  const names = [...mentioned.keys()].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const id = mentioned.get(name)!;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^\\w\\]])@${escaped}(?![\\w])`, "g"), `$1@[${name}](${id})`);
  }
  return out;
}

/** Markup → composer text (for editing). */
function fromMarkup(body: string, mentioned: Map<string, string>): string {
  return body.replace(MARKUP_RE, (_m, name: string, id: string) => {
    mentioned.set(name, id);
    return `@${name}`;
  });
}

function Composer({
  baseId,
  initial = "",
  placeholder,
  submitLabel,
  autoFocus,
  busy,
  onSubmit,
  onCancel,
}: {
  baseId: string;
  initial?: string;
  placeholder: string;
  submitLabel: string;
  autoFocus?: boolean;
  busy: boolean;
  onSubmit: (markup: string) => Promise<void> | void;
  onCancel?: () => void;
}) {
  const mentioned = useRef(new Map<string, string>());
  const [text, setText] = useState(() => fromMarkup(initial, mentioned.current));
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [active, setActive] = useState(0);
  const ta = useRef<HTMLTextAreaElement>(null);

  const collaborators = useQuery({
    queryKey: ["collaborators", baseId],
    queryFn: () => listCollaborators(baseId),
    staleTime: 60_000,
    enabled: mention !== null,
  });
  const candidates: Collaborator[] = useMemo(() => {
    if (!mention) return [];
    const q = mention.query.toLowerCase();
    return (collaborators.data?.collaborators ?? [])
      .filter((c) => c.name.toLowerCase().includes(q) || c.email.toLowerCase().includes(q))
      .slice(0, 6);
  }, [mention, collaborators.data]);

  function updateMention(value: string, caret: number) {
    const before = value.slice(0, caret);
    const m = /(^|\s)@([^\s@]{0,30})$/.exec(before);
    if (m) {
      setMention({ start: caret - m[2]!.length - 1, query: m[2]! });
      setActive(0);
    } else {
      setMention(null);
    }
  }

  function pick(c: Collaborator) {
    if (!mention) return;
    const caret = ta.current?.selectionStart ?? text.length;
    const insert = `@${c.name} `;
    const next = text.slice(0, mention.start) + insert + text.slice(caret);
    mentioned.current.set(c.name, c.id);
    setText(next);
    setMention(null);
    requestAnimationFrame(() => {
      const pos = mention.start + insert.length;
      ta.current?.focus();
      ta.current?.setSelectionRange(pos, pos);
    });
  }

  async function submit() {
    const body = text.trim();
    if (!body || busy) return;
    await onSubmit(toMarkup(body, mentioned.current));
    setText("");
    mentioned.current.clear();
  }

  return (
    <div className={styles.composer}>
      <textarea
        ref={ta}
        className={styles.textarea}
        value={text}
        rows={2}
        autoFocus={autoFocus}
        placeholder={placeholder}
        aria-label={placeholder}
        onChange={(e) => {
          setText(e.target.value);
          updateMention(e.target.value, e.target.selectionStart);
        }}
        onKeyDown={(e) => {
          if (mention && candidates.length) {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActive((a) => (a + 1) % candidates.length);
              return;
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setActive((a) => (a - 1 + candidates.length) % candidates.length);
              return;
            }
            if (e.key === "Enter" || e.key === "Tab") {
              e.preventDefault();
              pick(candidates[active]!);
              return;
            }
          }
          if (e.key === "Escape") {
            if (mention) setMention(null);
            else onCancel?.();
            return;
          }
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            void submit();
          }
        }}
      />
      {mention && candidates.length ? (
        <ul className={styles.mentionMenu} role="listbox" aria-label="Mention someone">
          {candidates.map((c, i) => (
            <li
              key={c.id}
              role="option"
              aria-selected={i === active}
              className={i === active ? styles.mentionOptionActive : styles.mentionOption}
              onMouseDown={(e) => {
                e.preventDefault();
                pick(c);
              }}
            >
              <span className={styles.avatarSm} style={{ background: colorFor(c.id) }}>
                {initialsOf(c.name)}
              </span>
              <span>
                <span className={styles.mentionName}>{c.name}</span>
                <span className={styles.mentionEmail}>{c.email}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div className={styles.composerActions}>
        <span className={styles.hint}>@ to mention · Ctrl+Enter to send</span>
        {onCancel ? (
          <button type="button" className={styles.btnGhost} onClick={onCancel}>
            Cancel
          </button>
        ) : null}
        <button type="button" className={styles.btnPrimary} disabled={!text.trim() || busy} onClick={() => void submit()}>
          {submitLabel}
        </button>
      </div>
    </div>
  );
}

/** Record comments panel (CONTRACTS §10), mounted by C in the record drawer. */
export function RecordComments({
  baseId,
  tableId,
  recordId,
}: {
  baseId: string;
  tableId: string;
  recordId: string;
}) {
  const qc = useQueryClient();
  const key = ["comments", baseId, tableId, recordId];
  const query = useQuery({
    queryKey: key,
    queryFn: () => commentsApi.list(baseId, tableId, recordId),
    refetchInterval: 20_000,
  });
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [pickerFor, setPickerFor] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    void qc.invalidateQueries({ queryKey: key });
    void qc.invalidateQueries({ queryKey: ["notifications"] });
  };
  const onError = (e: unknown) => setError(errorText(e));

  const create = useMutation({
    mutationFn: (v: { body: string; parentId?: string | null }) =>
      commentsApi.create(baseId, tableId, recordId, v.body, v.parentId ?? null),
    onSuccess: () => {
      setReplyTo(null);
      refresh();
    },
    onError,
  });
  const update = useMutation({
    mutationFn: (v: { id: string; body: string }) => commentsApi.update(baseId, v.id, v.body),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
    onError,
  });
  const remove = useMutation({
    mutationFn: (id: string) => commentsApi.remove(baseId, id),
    onSuccess: refresh,
    onError,
  });
  const react = useMutation({
    mutationFn: (v: { id: string; emoji: string }) => commentsApi.toggleReaction(baseId, v.id, v.emoji),
    onMutate: async (v) => {
      // Optimistic toggle.
      qc.setQueryData(key, (old: { comments: CommentWire[] } | undefined) =>
        old
          ? {
              comments: old.comments.map((c) => {
                if (c.id !== v.id) return c;
                const existing = c.reactions.find((r) => r.emoji === v.emoji);
                let reactions = c.reactions;
                if (existing?.reactedByMe) {
                  reactions = c.reactions
                    .map((r) => (r.emoji === v.emoji ? { ...r, count: r.count - 1, reactedByMe: false } : r))
                    .filter((r) => r.count > 0);
                } else if (existing) {
                  reactions = c.reactions.map((r) =>
                    r.emoji === v.emoji ? { ...r, count: r.count + 1, reactedByMe: true } : r,
                  );
                } else {
                  reactions = [...c.reactions, { emoji: v.emoji, count: 1, userIds: [], userNames: [], reactedByMe: true }];
                }
                return { ...c, reactions };
              }),
            }
          : old,
      );
      setPickerFor(null);
    },
    onSettled: refresh,
    onError,
  });

  const comments = query.data?.comments ?? [];
  const roots = comments.filter((c) => !c.parentId || !comments.some((p) => p.id === c.parentId));
  const repliesOf = (id: string) => comments.filter((c) => c.parentId === id);

  function renderComment(c: CommentWire, isReply: boolean) {
    const name = c.author?.name ?? c.authorName ?? "Unknown";
    return (
      <li key={c.id} className={isReply ? styles.reply : styles.comment}>
        <span
          className={styles.avatar}
          style={{ background: colorFor(c.author?.id ?? c.id) }}
          aria-hidden
        >
          {c.author?.initials ?? initialsOf(name)}
        </span>
        <div className={styles.main}>
          <div className={styles.meta}>
            <span className={styles.author}>{name}</span>
            <time className={styles.time} dateTime={c.createdAt} title={new Date(c.createdAt).toLocaleString()}>
              {relativeTime(c.createdAt)}
            </time>
            {c.edited ? <span className={styles.time}>(edited)</span> : null}
          </div>
          {editing === c.id ? (
            <Composer
              baseId={baseId}
              initial={c.body}
              placeholder="Edit comment"
              submitLabel="Save"
              autoFocus
              busy={update.isPending}
              onSubmit={(body) => update.mutateAsync({ id: c.id, body }).then(() => undefined)}
              onCancel={() => setEditing(null)}
            />
          ) : (
            <div className={styles.body}>{renderBody(c.body)}</div>
          )}
          <div className={styles.actions}>
            {c.reactions.map((r) => (
              <button
                key={r.emoji}
                type="button"
                className={r.reactedByMe ? styles.reactionMine : styles.reaction}
                title={r.userNames.filter(Boolean).join(", ")}
                onClick={() => react.mutate({ id: c.id, emoji: r.emoji })}
              >
                {r.emoji} <span>{r.count}</span>
              </button>
            ))}
            <span className={styles.pickerWrap}>
              <button
                type="button"
                className={styles.actionBtn}
                aria-label="Add reaction"
                onClick={() => setPickerFor(pickerFor === c.id ? null : c.id)}
              >
                ☺+
              </button>
              {pickerFor === c.id ? (
                <span className={styles.picker} role="menu">
                  {REACTIONS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      role="menuitem"
                      className={styles.pickerBtn}
                      onClick={() => react.mutate({ id: c.id, emoji: e })}
                    >
                      {e}
                    </button>
                  ))}
                </span>
              ) : null}
            </span>
            {!isReply ? (
              <button type="button" className={styles.actionBtn} onClick={() => setReplyTo(replyTo === c.id ? null : c.id)}>
                Reply
              </button>
            ) : null}
            {c.isMine && editing !== c.id ? (
              <>
                <button type="button" className={styles.actionBtn} onClick={() => setEditing(c.id)}>
                  Edit
                </button>
                <button
                  type="button"
                  className={styles.actionBtnDanger}
                  onClick={() => {
                    if (window.confirm("Delete this comment?")) remove.mutate(c.id);
                  }}
                >
                  Delete
                </button>
              </>
            ) : null}
          </div>
        </div>
      </li>
    );
  }

  return (
    <section className={styles.panel} aria-label="Comments">
      {error ? <p className={styles.error}>{error}</p> : null}
      {query.isLoading ? <p className={styles.empty}>Loading comments…</p> : null}
      {query.isError ? <p className={styles.error}>{errorText(query.error)}</p> : null}
      {query.isSuccess && comments.length === 0 ? (
        <p className={styles.empty}>No comments yet. Start the conversation, and @mention teammates to notify them.</p>
      ) : null}
      <ul className={styles.list}>
        {roots.map((c) => (
          <Fragment key={c.id}>
            {renderComment(c, false)}
            {repliesOf(c.id).length || replyTo === c.id ? (
              <li className={styles.thread}>
                <ul className={styles.list}>
                  {repliesOf(c.id).map((r) => renderComment(r, true))}
                </ul>
                {replyTo === c.id ? (
                  <Composer
                    baseId={baseId}
                    placeholder={`Reply to ${c.author?.name ?? "comment"}`}
                    submitLabel="Reply"
                    autoFocus
                    busy={create.isPending}
                    onSubmit={(body) => create.mutateAsync({ body, parentId: c.id }).then(() => undefined)}
                    onCancel={() => setReplyTo(null)}
                  />
                ) : null}
              </li>
            ) : null}
          </Fragment>
        ))}
      </ul>
      <Composer
        baseId={baseId}
        placeholder="Leave a comment"
        submitLabel="Comment"
        busy={create.isPending}
        onSubmit={(body) => create.mutateAsync({ body }).then(() => undefined)}
      />
    </section>
  );
}

export default RecordComments;
