import { useEffect, useMemo, useState } from "react";
import { FIELD_TYPES, fieldTypeIcon, fieldTypeLabel } from "@tabula/field-ui";
import type { TableDto } from "../../lib/api.ts";
import type { FieldWire } from "../../lib/api-areas/fields.ts";
import { ConfirmDialog } from "../grid/Menu.tsx";
import { Toaster } from "../grid/toast.tsx";
import { FieldDialog } from "./FieldDialog.tsx";
import { useFieldActions } from "./field-actions.ts";
import styles from "./field-dialog.module.css";

/**
 * Manage all fields of a table: reorder (table default order), rename,
 * change type, hide in the current view, delete. CONTRACTS §10.
 */
export function FieldManager({
  baseId,
  table,
  onClose,
  hiddenFieldIds,
  onHiddenChange,
}: {
  baseId: string;
  table: TableDto;
  onClose: () => void;
  /** Current view's hidden fields (enables the "visible" toggles). */
  hiddenFieldIds?: string[];
  onHiddenChange?: (hiddenFieldIds: string[]) => void;
}) {
  const actions = useFieldActions(baseId, table.id);
  const fields = table.fields as unknown as FieldWire[];
  const [order, setOrder] = useState<string[]>(() => fields.map((f) => f.id));
  const [names, setNames] = useState<Record<string, string>>({});
  const [dragId, setDragId] = useState<string | null>(null);
  const [overId, setOverId] = useState<string | null>(null);
  const [editField, setEditField] = useState<{ field: FieldWire } | { add: true } | null>(null);
  const [confirmDel, setConfirmDel] = useState<FieldWire | null>(null);

  useEffect(() => {
    setOrder((prev) => {
      const ids = fields.map((f) => f.id);
      const kept = prev.filter((id) => ids.includes(id));
      return [...kept, ...ids.filter((id) => !kept.includes(id))];
    });
  }, [fields]);

  const byId = useMemo(() => new Map(fields.map((f) => [f.id, f])), [fields]);
  const isPrimary = (f: FieldWire) => f.isPrimary || f.id === table.primaryFieldId;

  const commitName = (f: FieldWire) => {
    const next = names[f.id]?.trim();
    if (next === undefined) return;
    setNames((n) => {
      const { [f.id]: _drop, ...rest } = n;
      return rest;
    });
    if (next && next !== f.name) void actions.update(f.id, { name: next }).catch(() => undefined);
  };

  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const next = order.filter((id) => id !== dragId);
    next.splice(next.indexOf(targetId), 0, dragId);
    setOrder(next);
    void actions.reorder(next).catch(() => setOrder(fields.map((f) => f.id)));
  };

  return (
    <div
      className={styles.back}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape" && !editField && !confirmDel) onClose();
      }}
    >
      <div className={`${styles.panel} ${styles.manager}`} role="dialog" aria-label="Manage fields">
        <div className={styles.scroll}>
          <h2 className={styles.title}>Manage fields · {table.name}</h2>
          <span className={styles.desc}>
            Drag to change the default field order. Use the eye toggles to hide fields in the current view.
          </span>
          <div className={styles.mList}>
            {order.map((id) => {
              const f = byId.get(id);
              if (!f) return null;
              const hidden = hiddenFieldIds?.includes(f.id) ?? false;
              return (
                <div
                  key={f.id}
                  className={`${styles.mRow} ${dragId === f.id ? styles.mRowDrag : ""} ${overId === f.id && dragId !== f.id ? styles.mRowOver : ""}`}
                  draggable
                  onDragStart={(e) => {
                    setDragId(f.id);
                    e.dataTransfer.effectAllowed = "move";
                  }}
                  onDragOver={(e) => {
                    e.preventDefault();
                    setOverId(f.id);
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    drop(f.id);
                  }}
                  onDragEnd={() => {
                    setDragId(null);
                    setOverId(null);
                  }}
                >
                  <span className={styles.mGrip} aria-hidden>
                    ⋮⋮
                  </span>
                  <span className={styles.typeIcon} title={fieldTypeLabel(f.type)}>
                    {fieldTypeIcon(f.type)}
                  </span>
                  <input
                    className={styles.mName}
                    aria-label={`Rename ${f.name}`}
                    value={names[f.id] ?? f.name}
                    onChange={(e) => setNames((n) => ({ ...n, [f.id]: e.target.value }))}
                    onBlur={() => commitName(f)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") (e.target as HTMLInputElement).blur();
                    }}
                  />
                  <select
                    className={styles.mType}
                    aria-label={`Type of ${f.name}`}
                    value={f.type}
                    onChange={(e) => setEditField({ field: { ...f, type: e.target.value, config: {} } as FieldWire })}
                  >
                    {FIELD_TYPES.map((t) => (
                      <option key={t.type} value={t.type}>
                        {t.label}
                      </option>
                    ))}
                    {!FIELD_TYPES.some((t) => t.type === f.type) ? <option value={f.type}>{f.type}</option> : null}
                  </select>
                  {isPrimary(f) ? (
                    <span className={styles.mPrimary}>Primary</span>
                  ) : onHiddenChange && hiddenFieldIds ? (
                    <label className={styles.mVis}>
                      <input
                        type="checkbox"
                        checked={!hidden}
                        onChange={(e) =>
                          onHiddenChange(e.target.checked ? hiddenFieldIds.filter((x) => x !== f.id) : [...hiddenFieldIds, f.id])
                        }
                      />
                      Visible
                    </label>
                  ) : (
                    <span />
                  )}
                  <span style={{ display: "flex" }}>
                    <button type="button" className={styles.mIconBtn} title="Edit field" aria-label={`Edit ${f.name}`} onClick={() => setEditField({ field: f })}>
                      ✎
                    </button>
                    <button
                      type="button"
                      className={styles.mIconBtn}
                      title={isPrimary(f) ? "The primary field can't be deleted" : "Delete field"}
                      aria-label={`Delete ${f.name}`}
                      disabled={isPrimary(f)}
                      onClick={() => setConfirmDel(f)}
                    >
                      🗑
                    </button>
                  </span>
                </div>
              );
            })}
          </div>
          <button type="button" className={styles.linkBtn} onClick={() => setEditField({ add: true })}>
            + Add field
          </button>
        </div>
        <div className={styles.footer}>
          <button type="button" className={styles.btnPrimary} onClick={onClose}>
            Done
          </button>
        </div>
      </div>
      {editField ? (
        "add" in editField ? (
          <FieldDialog baseId={baseId} table={table} onClose={() => setEditField(null)} />
        ) : (
          <FieldDialog
            baseId={baseId}
            table={table}
            // When the type select changed, open the dialog pre-set to the new type.
            field={byId.get(editField.field.id)!}
            {...(editField.field.type !== byId.get(editField.field.id)?.type ? { initialType: editField.field.type } : {})}
            onClose={() => setEditField(null)}
          />
        )
      ) : null}
      {confirmDel ? (
        <ConfirmDialog
          title={`Delete field "${confirmDel.name}"?`}
          body="All values in this field will be removed from every record."
          confirmLabel="Delete field"
          onCancel={() => setConfirmDel(null)}
          onConfirm={() => {
            const f = confirmDel;
            setConfirmDel(null);
            void actions.remove(f.id).catch(() => undefined);
          }}
        />
      ) : null}
      <Toaster />
    </div>
  );
}
