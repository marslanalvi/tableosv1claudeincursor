import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  FIELD_TYPES,
  FieldConfigEditor,
  FieldUiServicesProvider,
  defaultFieldConfig,
  fieldTypeInfo,
  validateFieldConfig,
  type FieldLike,
  type TableLike,
} from "@tabula/field-ui";
import type { TableDto } from "../../lib/api.ts";
import type { FieldWire } from "../../lib/api-areas/fields.ts";
import { useBaseDetail, useFieldServices } from "../grid/field-services.tsx";
import { Toaster } from "../grid/toast.tsx";
import { useFieldActions } from "./field-actions.ts";
import styles from "./field-dialog.module.css";

const GROUPS: Array<{ key: string; label: string }> = [
  { key: "basic", label: "Standard fields" },
  { key: "advanced", label: "Advanced fields" },
  { key: "computed", label: "Computed fields" },
  { key: "meta", label: "Record metadata" },
];

function sampleRecordFromCache(qc: ReturnType<typeof useQueryClient>, baseId: string, tableId: string) {
  for (const [, data] of qc.getQueriesData<unknown>({ queryKey: ["records", baseId, tableId] })) {
    const d = data as { pages?: { records?: unknown[] }[]; records?: unknown[] } | unknown[] | undefined;
    const first = Array.isArray(d) ? d[0] : (d?.pages?.[0]?.records?.[0] ?? d?.records?.[0]);
    if (first && typeof first === "object") return first as { id: string; fields: Record<string, unknown> };
  }
  return undefined;
}

/**
 * Add / edit field dialog (name, type picker with icons + descriptions,
 * description, type-specific configuration).
 */
export function FieldDialog({
  baseId,
  table,
  field,
  initialType,
  onClose,
  onSaved,
}: {
  baseId: string;
  table: TableDto;
  /** Present when editing an existing field. */
  field?: FieldWire | undefined;
  initialType?: string;
  onClose: () => void;
  onSaved?: (field: FieldWire) => void;
}) {
  const qc = useQueryClient();
  const actions = useFieldActions(baseId, table.id);
  const services = useFieldServices(baseId);
  const base = useBaseDetail(baseId);
  const editing = !!field;
  const [name, setName] = useState(field?.name ?? "");
  const [type, setType] = useState(initialType ?? field?.type ?? "text");
  const [config, setConfig] = useState<Record<string, unknown>>(() =>
    field && (!initialType || initialType === field.type)
      ? { ...(field.config ?? {}) }
      : defaultFieldConfig(initialType ?? "text", { tables: base.data?.tables as unknown as TableLike[] | undefined, tableId: table.id }),
  );
  const [description, setDescription] = useState(field?.description ?? "");
  const [showDesc, setShowDesc] = useState(!!field?.description);
  const [picking, setPicking] = useState(!editing && !initialType);
  const [query, setQuery] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const isPrimary = !!field && (field.isPrimary || field.id === table.primaryFieldId);

  useEffect(() => {
    if (!picking) nameRef.current?.focus();
  }, [picking]);

  const tables = (base.data?.tables ?? []) as unknown as TableLike[];
  const fields = table.fields as unknown as FieldLike[];
  const sample = useMemo(() => sampleRecordFromCache(qc, baseId, table.id), [qc, baseId, table.id]);

  const filtered = FIELD_TYPES.filter((t) => {
    if (isPrimary && ["link", "attachment", "button", "checkbox"].includes(t.type)) return false;
    const q = query.trim().toLowerCase();
    return !q || t.label.toLowerCase().includes(q) || t.description.toLowerCase().includes(q);
  });

  const info = fieldTypeInfo(type);
  const validation = validateFieldConfig(type, config, fields, field?.id);
  const typeChanged = editing && field!.type !== type;

  const chooseType = (t: string) => {
    setType(t);
    if (!editing || t !== field!.type) {
      const prevOptions = config["options"];
      const next = defaultFieldConfig(t, { tables, tableId: table.id });
      // Keep select options when switching between single/multi select.
      if ((t === "single_select" || t === "multi_select") && Array.isArray(prevOptions)) next["options"] = prevOptions;
      setConfig(next);
    } else {
      setConfig({ ...(field!.config ?? {}) });
    }
    if (!name.trim() || FIELD_TYPES.some((x) => x.label === name)) setName(fieldTypeInfo(t).label);
    setPicking(false);
    setQuery("");
  };

  const submit = async () => {
    setTouched(true);
    if (validation) return;
    const trimmed = name.trim() || info.label;
    const dup = table.fields.find((f) => f.name.toLowerCase() === trimmed.toLowerCase() && f.id !== field?.id);
    if (dup) {
      setError(`A field named "${trimmed}" already exists.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      let saved: FieldWire;
      if (editing) {
        const body: { name?: string; type?: string; config?: Record<string, unknown>; description?: string | null } = {};
        if (trimmed !== field!.name) body.name = trimmed;
        if (typeChanged) body.type = type;
        if (JSON.stringify(config) !== JSON.stringify(field!.config ?? {}) || typeChanged) body.config = config;
        if ((description || null) !== (field!.description ?? null)) body.description = description.trim() || null;
        saved = Object.keys(body).length ? await actions.update(field!.id, body) : field!;
      } else {
        saved = await actions.create({
          name: trimmed,
          type,
          config,
          ...(description.trim() ? { description: description.trim() } : {}),
        });
      }
      onSaved?.(saved);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save field");
    } finally {
      setSaving(false);
    }
  };

  return (
    <FieldUiServicesProvider value={services}>
      <div
        className={styles.back}
        onMouseDown={(e) => {
          e.stopPropagation();
          if (e.target === e.currentTarget) onClose();
        }}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Escape") {
            e.preventDefault();
            if (picking && editing) setPicking(false);
            else onClose();
          }
        }}
        onContextMenu={(e) => e.stopPropagation()}
      >
        <form
          className={styles.panel}
          role="dialog"
          aria-label={editing ? "Edit field" : "Add field"}
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className={styles.scroll}>
            <h2 className={styles.title}>{editing ? "Edit field" : "Add field"}</h2>
            <input
              ref={nameRef}
              className={styles.input}
              value={name}
              placeholder="Field name (optional)"
              aria-label="Field name"
              onChange={(e) => setName(e.target.value)}
            />
            {picking ? (
              <>
                <input
                  className={styles.input}
                  autoFocus
                  value={query}
                  placeholder="Find a field type"
                  aria-label="Find a field type"
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      if (filtered[0]) chooseType(filtered[0].type);
                    }
                  }}
                />
                <div className={styles.typeList} role="listbox">
                  {GROUPS.map((g) => {
                    const items = filtered.filter((t) => t.group === g.key);
                    if (!items.length) return null;
                    return (
                      <div key={g.key} style={{ display: "contents" }}>
                        <div className={styles.groupLabel}>{g.label}</div>
                        {items.map((t) => (
                          <button
                            key={t.type}
                            type="button"
                            role="option"
                            aria-selected={t.type === type}
                            className={`${styles.typeItem} ${t.type === type ? styles.typeItemActive : ""}`}
                            onClick={() => chooseType(t.type)}
                          >
                            <span className={styles.typeIcon}>{t.icon}</span>
                            <span>
                              <span className={styles.typeName}>{t.label}</span>
                              <span className={styles.typeDesc}>{t.description}</span>
                            </span>
                          </button>
                        ))}
                      </div>
                    );
                  })}
                  {filtered.length === 0 ? <div className={styles.desc} style={{ padding: 8 }}>No matching field types</div> : null}
                </div>
              </>
            ) : (
              <button type="button" className={styles.typeBtn} onClick={() => setPicking(true)} aria-label="Field type">
                <span className={styles.typeIcon}>{info.icon}</span>
                {info.label}
                <span className={styles.chev}>▾</span>
              </button>
            )}
            {!picking ? (
              <>
                <span className={styles.desc}>{info.description}</span>
                {typeChanged ? (
                  <div className={styles.warning}>
                    Changing the type from {fieldTypeInfo(field!.type).label} to {info.label} converts existing values; values
                    that can't be converted will be cleared.
                  </div>
                ) : null}
                <FieldConfigEditor
                  type={type}
                  config={config}
                  onChange={setConfig}
                  fields={fields}
                  tables={tables}
                  tableId={table.id}
                  fieldId={field?.id}
                  sampleRecord={sample}
                />
                {showDesc ? (
                  <textarea
                    className={`${styles.input} ${styles.textarea}`}
                    value={description}
                    placeholder="Describe this field (optional)"
                    aria-label="Field description"
                    onChange={(e) => setDescription(e.target.value)}
                  />
                ) : (
                  <button type="button" className={styles.linkBtn} onClick={() => setShowDesc(true)}>
                    + Add description
                  </button>
                )}
                {touched && validation ? <div className={styles.error}>{validation}</div> : null}
                {error ? <div className={styles.error}>{error}</div> : null}
              </>
            ) : null}
          </div>
          <div className={styles.footer}>
            <button type="button" className={styles.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={styles.btnPrimary} disabled={saving || picking}>
              {saving ? "Saving…" : editing ? "Save" : "Create field"}
            </button>
          </div>
        </form>
        <Toaster />
      </div>
    </FieldUiServicesProvider>
  );
}
