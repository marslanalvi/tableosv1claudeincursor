import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "@tanstack/react-router";
import { notificationsApi, relativeTime, type NotificationWire } from "../../lib/api-areas/collab.ts";
import { navigateToLink } from "../search/SearchPalette.tsx";
import styles from "./notifications.module.css";

const POLL_MS = 30_000;

function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "•"
  );
}

function BellIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M10 20a2 2 0 0 0 4 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread">("all");
  const qc = useQueryClient();
  const router = useRouter();
  const ref = useRef<HTMLDivElement>(null);

  const query = useQuery({
    queryKey: ["notifications"],
    queryFn: () => notificationsApi.list(),
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
  });

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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

  const invalidate = () => void qc.invalidateQueries({ queryKey: ["notifications"] });
  const markRead = useMutation({ mutationFn: (id: string) => notificationsApi.markRead(id), onSuccess: invalidate });
  const markUnread = useMutation({ mutationFn: (id: string) => notificationsApi.markUnread(id), onSuccess: invalidate });
  const markAll = useMutation({ mutationFn: () => notificationsApi.markAllRead(), onSuccess: invalidate });

  const unread = query.data?.unreadCount ?? 0;
  const all: NotificationWire[] = query.data?.notifications ?? [];
  const list = filter === "unread" ? all.filter((n) => !n.readAt) : all;

  function openItem(n: NotificationWire) {
    if (!n.readAt) markRead.mutate(n.id);
    setOpen(false);
    if (n.link) void navigateToLink(router, n.link);
  }

  return (
    <div className={styles.wrap} ref={ref}>
      <button
        type="button"
        className={styles.bell}
        aria-label={`Notifications${unread ? `, ${unread} unread` : ""}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
        {unread > 0 ? <span className={styles.badge}>{unread > 99 ? "99+" : unread}</span> : null}
      </button>
      {open ? (
        <div className={styles.panel} role="dialog" aria-label="Notifications">
          <div className={styles.panelHeader}>
            <span className={styles.panelTitle}>Notifications</span>
            <button
              type="button"
              className={styles.linkBtn}
              disabled={unread === 0 || markAll.isPending}
              onClick={() => markAll.mutate()}
            >
              Mark all as read
            </button>
          </div>
          <div className={styles.filters} role="tablist">
            {(["all", "unread"] as const).map((f) => (
              <button
                key={f}
                type="button"
                role="tab"
                aria-selected={filter === f}
                className={filter === f ? styles.filterActive : styles.filter}
                onClick={() => setFilter(f)}
              >
                {f === "all" ? "All" : `Unread${unread ? ` (${unread})` : ""}`}
              </button>
            ))}
          </div>
          <ul className={styles.list}>
            {query.isLoading ? <li className={styles.empty}>Loading…</li> : null}
            {query.isError ? <li className={styles.empty}>Couldn’t load notifications.</li> : null}
            {query.isSuccess && list.length === 0 ? (
              <li className={styles.empty}>
                {filter === "unread" ? "You’re all caught up." : "No notifications yet. Mentions and replies to your comments show up here."}
              </li>
            ) : null}
            {list.map((n) => (
              <li key={n.id} className={n.readAt ? styles.item : styles.itemUnread}>
                <button type="button" className={styles.itemMain} onClick={() => openItem(n)}>
                  <span className={styles.avatar} aria-hidden>
                    {initials(n.actor?.name ?? "")}
                  </span>
                  <span className={styles.itemText}>
                    <span className={styles.itemTitle}>{n.title}</span>
                    {n.body ? <span className={styles.itemBody}>{n.body}</span> : null}
                    <span className={styles.itemMeta}>{relativeTime(n.createdAt)}</span>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.dotBtn}
                  title={n.readAt ? "Mark as unread" : "Mark as read"}
                  aria-label={n.readAt ? "Mark as unread" : "Mark as read"}
                  onClick={() => (n.readAt ? markUnread.mutate(n.id) : markRead.mutate(n.id))}
                >
                  <span className={n.readAt ? styles.dotEmpty : styles.dot} />
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
