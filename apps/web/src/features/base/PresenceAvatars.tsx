import { useOtherUsers } from "../../stores/presence.ts";
import { Avatar } from "../../app/ui.tsx";
import styles from "./presence.module.css";

/** Avatars of other users currently in this base (live via realtime presence). */
export function PresenceAvatars({
  tableNames,
}: {
  /** tbl_ id → name, to say where each collaborator is. */
  tableNames?: Record<string, string>;
}) {
  const others = useOtherUsers();
  if (others.length === 0) return null;
  const shown = others.slice(0, 5);
  const extra = others.length - shown.length;
  return (
    <div className={styles.row} aria-label="Collaborators viewing this base">
      {shown.map((entry) => {
        const where = entry.state.tableId ? tableNames?.[entry.state.tableId] : undefined;
        const title = where ? `${entry.user.name} — viewing ${where}` : entry.user.name;
        return (
          <span key={entry.user.id} className={styles.ring} style={{ borderColor: entry.color }}>
            <Avatar name={entry.user.name} color={entry.color} size={26} title={title} />
          </span>
        );
      })}
      {extra > 0 ? <span className={styles.more}>+{extra}</span> : null}
    </div>
  );
}
