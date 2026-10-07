import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import type { TableDto } from "../../lib/api.ts";
import { api } from "../../lib/api.ts";
import { shellApi } from "../../lib/api-areas/shell.ts";
import { ConfirmDialog, Dialog, DropdownMenu, uiStyles } from "../../app/ui.tsx";
import { toast, errorMessage } from "../../app/toast.tsx";
import styles from "./base-shell.module.css";

function InlineRename({
  initial,
  onDone,
  onCancel,
}: {
  initial: string;
  onDone: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  const settled = useRef(false);
  useEffect(() => {
    ref.current?.select();
  }, []);
  const commit = () => {
    if (settled.current) return;
    settled.current = true;
    const v = value.trim();
    if (v && v !== initial) onDone(v);
    else onCancel();
  };
  return (
    <input
      ref={ref}
      className={styles.tabRename}
      value={value}
      size={Math.max(4, value.length + 1)}
      aria-label="Table name"
      onChange={(e) => setValue(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit();
        if (e.key === "Escape") {
          settled.current = true;
          onCancel();
        }
      }}
    />
  );
}

function AddTableDialog({
  baseId,
  defaultName,
  onCreated,
  onClose,
}: {
  baseId: string;
  defaultName: string;
  onCreated: (tableId: string, importCsv: boolean) => void;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(defaultName);
  const [mode, setMode] = useState<"blank" | "import">("blank");
  const create = useMutation({
    mutationFn: () => api.createTable(baseId, name.trim()),
    onSuccess: async (res) => {
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      onCreated(res.table.id, mode === "import");
    },
  });
  return (
    <Dialog
      title="Add a table"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={uiStyles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={uiStyles.btnPrimary}
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : mode === "import" ? "Create and import" : "Create table"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <div className={uiStyles.field}>
          <label className={uiStyles.label} htmlFor="new-table-name">
            Table name
          </label>
          <input
            id="new-table-name"
            className={uiStyles.input}
            value={name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className={uiStyles.label}>Start with</div>
        <div className={styles.startOptions}>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "blank"}
            onClick={() => setMode("blank")}
          >
            <strong>Blank table</strong>
            <span>Start with a name field and a grid view.</span>
          </button>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "import"}
            onClick={() => setMode("import")}
          >
            <strong>Import CSV</strong>
            <span>Create the table, then upload a CSV file.</span>
          </button>
        </div>
        {create.isError ? <p className={uiStyles.error}>{errorMessage(create.error)}</p> : null}
      </form>
    </Dialog>
  );
}

/**
 * Airtable-style table tab bar: click to switch, double-click to rename,
 * caret menu (rename / duplicate / import / export / delete), drag to reorder,
 * "+ Add or import" dialog.
 */
export function TableTabs({
  baseId,
  tables,
  activeTableId,
  onSelect,
  onImport,
  onExport,
}: {
  baseId: string;
  tables: TableDto[];
  activeTableId: string | null;
  onSelect: (tableId: string) => void;
  onImport: (tableId: string) => void;
  onExport: (tableId: string) => void;
}) {
  const qc = useQueryClient();
  const [renaming, setRenaming] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<TableDto | null>(null);
  const [adding, setAdding] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [optimisticOrder, setOptimisticOrder] = useState<string[] | null>(null);

  const refresh = () => qc.invalidateQueries({ queryKey: ["bases", baseId] });

  const rename = useMutation({
    mutationFn: (v: { tableId: string; name: string }) =>
      shellApi.renameTable(baseId, v.tableId, v.name),
    onSuccess: () => void refresh(),
    onError: (err) => toast.error(err, "Could not rename table"),
    onSettled: () => setRenaming(null),
  });
  const duplicate = useMutation({
    mutationFn: (v: { tableId: string; withRecords: boolean }) =>
      shellApi.duplicateTable(baseId, v.tableId, v.withRecords),
    onSuccess: async (res) => {
      await refresh();
      onSelect(res.table.id);
      toast.success(`Created “${res.table.name}”`);
    },
    onError: (err) => toast.error(err, "Could not duplicate table"),
  });
  const remove = useMutation({
    mutationFn: (tableId: string) => shellApi.deleteTable(baseId, tableId),
    onSuccess: async (_r, tableId) => {
      const idx = tables.findIndex((t) => t.id === tableId);
      const next = tables[idx + 1] ?? tables[idx - 1];
      await refresh();
      if (next && tableId === activeTableId) onSelect(next.id);
      setDeleting(null);
      toast.success("Table deleted — restore it from Trash or press Ctrl+Z");
    },
    onError: (err) => toast.error(err, "Could not delete table"),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => shellApi.reorderTables(baseId, ids),
    onSuccess: async () => {
      await refresh();
      setOptimisticOrder(null);
    },
    onError: (err) => {
      setOptimisticOrder(null);
      toast.error(err, "Could not reorder tables");
    },
  });

  const ordered = optimisticOrder
    ? (optimisticOrder
        .map((id) => tables.find((t) => t.id === id))
        .filter(Boolean) as TableDto[])
    : tables;

  const finishDrop = () => {
    if (dragId === null || dropIndex === null) return;
    const ids = ordered.map((t) => t.id).filter((id) => id !== dragId);
    const from = ordered.findIndex((t) => t.id === dragId);
    const target = dropIndex > from ? dropIndex - 1 : dropIndex;
    ids.splice(target, 0, dragId);
    if (ids.join() !== ordered.map((t) => t.id).join()) {
      setOptimisticOrder(ids);
      reorder.mutate(ids);
    }
    setDragId(null);
    setDropIndex(null);
  };

  return (
    <div
      className={styles.tableTabs}
      role="tablist"
      aria-label="Tables"
      onDragOver={(e) => dragId && e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        finishDrop();
      }}
    >
      {ordered.map((table, index) => {
        const active = table.id === activeTableId;
        return (
          <div
            key={table.id}
            className={styles.tableTab}
            data-active={active}
            data-drop-before={dropIndex === index && dragId !== null}
            data-drop-after={
              dropIndex === ordered.length && index === ordered.length - 1 && dragId !== null
            }
            draggable={renaming !== table.id}
            onDragStart={(e) => {
              setDragId(table.id);
              e.dataTransfer.effectAllowed = "move";
              e.dataTransfer.setData("text/plain", table.id);
            }}
            onDragEnd={() => {
              setDragId(null);
              setDropIndex(null);
            }}
            onDragOver={(e) => {
              if (!dragId) return;
              e.preventDefault();
              const rect = e.currentTarget.getBoundingClientRect();
              const after = e.clientX > rect.left + rect.width / 2;
              setDropIndex(after ? index + 1 : index);
            }}
          >
            {renaming === table.id ? (
              <InlineRename
                initial={table.name}
                onDone={(name) => rename.mutate({ tableId: table.id, name })}
                onCancel={() => setRenaming(null)}
              />
            ) : (
              <button
                type="button"
                role="tab"
                aria-selected={active}
                className={styles.tableTabLabel}
                title="Double-click to rename"
                onClick={() => onSelect(table.id)}
                onDoubleClick={() => setRenaming(table.id)}
              >
                {table.name}
              </button>
            )}
            {active && renaming !== table.id ? (
              <DropdownMenu
                trigger={({ toggle }) => (
                  <button
                    type="button"
                    className={styles.tabCaret}
                    aria-label={`${table.name} options`}
                    onClick={toggle}
                  >
                    ▾
                  </button>
                )}
                items={[
                  { key: "rename", label: "Rename table", icon: "✎", onSelect: () => setRenaming(table.id) },
                  {
                    key: "dup",
                    label: "Duplicate table",
                    icon: "⧉",
                    onSelect: () => duplicate.mutate({ tableId: table.id, withRecords: true }),
                  },
                  {
                    key: "dup-empty",
                    label: "Duplicate structure only",
                    icon: "⧉",
                    onSelect: () => duplicate.mutate({ tableId: table.id, withRecords: false }),
                  },
                  {
                    key: "import",
                    label: "Import CSV into this table",
                    icon: "⤓",
                    separatorBefore: true,
                    onSelect: () => onImport(table.id),
                  },
                  { key: "export", label: "Export CSV", icon: "⤒", onSelect: () => onExport(table.id) },
                  {
                    key: "copy",
                    label: "Copy table ID",
                    icon: "#",
                    onSelect: () =>
                      void navigator.clipboard
                        ?.writeText(table.id)
                        .then(() => toast.success("Table ID copied"))
                        .catch(() => toast.info(table.id)),
                  },
                  {
                    key: "delete",
                    label: "Delete table",
                    icon: "🗑",
                    danger: true,
                    separatorBefore: true,
                    disabled: tables.length <= 1,
                    onSelect: () => setDeleting(table),
                  },
                ]}
              />
            ) : null}
          </div>
        );
      })}
      <button
        type="button"
        className={styles.addTable}
        onClick={() => setAdding(true)}
        title="Add or import a table"
      >
        + Add or import
      </button>

      {adding ? (
        <AddTableDialog
          baseId={baseId}
          defaultName={`Table ${tables.length + 1}`}
          onClose={() => setAdding(false)}
          onCreated={(tableId, importCsv) => {
            setAdding(false);
            onSelect(tableId);
            if (importCsv) onImport(tableId);
          }}
        />
      ) : null}
      {deleting ? (
        <ConfirmDialog
          title="Delete table?"
          message={
            <>
              <strong>{deleting.name}</strong> and its records, fields and views will be moved to
              the trash. You can restore it from <em>Tools → Trash</em>.
            </>
          }
          confirmLabel="Delete table"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(deleting.id)}
          onClose={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}
