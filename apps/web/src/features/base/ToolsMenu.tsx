import { DropdownMenu } from "../../app/ui.tsx";
import styles from "./base-shell.module.css";

/** Tools ▾ — only actions that work (no placeholders). */
export function ToolsMenu({
  onManageFields,
  onImport,
  onExport,
  onTrash,
  disabled,
}: {
  onManageFields: () => void;
  onImport: () => void;
  onExport: () => void;
  onTrash: () => void;
  disabled?: boolean;
}) {
  const detail = (title: string, text: string) => (
    <span className={styles.toolItem}>
      <span>{title}</span>
      <span className={styles.toolDetail}>{text}</span>
    </span>
  );
  return (
    <DropdownMenu
      align="right"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          className={styles.toolsTrigger}
          aria-expanded={open}
          disabled={disabled}
          onClick={toggle}
        >
          Tools ▾
        </button>
      )}
      items={[
        {
          key: "fields",
          icon: "A",
          label: detail("Manage fields", "Rename, edit, hide or delete fields"),
          onSelect: onManageFields,
        },
        {
          key: "import",
          icon: "⤓",
          label: detail("Import CSV", "Add records from a spreadsheet file"),
          onSelect: onImport,
        },
        {
          key: "export",
          icon: "⤒",
          label: detail("Export CSV", "Download this view as a CSV file"),
          onSelect: onExport,
        },
        {
          key: "trash",
          icon: "🗑",
          separatorBefore: true,
          label: detail("Trash", "Restore deleted records, fields and tables"),
          onSelect: onTrash,
        },
      ]}
    />
  );
}
