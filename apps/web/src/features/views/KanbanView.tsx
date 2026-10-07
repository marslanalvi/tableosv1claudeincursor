import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { request, type FieldDto } from "../../lib/api.ts";
import type { ViewRecord } from "../../lib/api-areas/views.ts";
import { useCollaborators } from "./field-value.tsx";
import { RecordCard, cardFields, coverUrl } from "./RecordCard.tsx";
import { RecordsStatus, statusProps } from "./RecordsStatus.tsx";
import { useRecordWrites, useViewRecords, type ViewComponentProps } from "./view-hooks.ts";
import { COLOR_NAMES, colorOf, randomOptionId, selectOptions } from "./view-utils.ts";
import styles from "./views.module.css";

const UNCATEGORIZED = "__none__";

interface Stack {
  key: string;
  label: string;
  color?: string | undefined;
}

function stackKeyOf(field: FieldDto, record: ViewRecord): string {
  const v = record.fields[field.id];
  if (field.type === "collaborator") {
    const first = Array.isArray(v) ? v[0] : v;
    if (!first) return UNCATEGORIZED;
    return typeof first === "string" ? first : String((first as unknown as { id: string }).id);
  }
  return typeof v === "string" && v ? v : UNCATEGORIZED;
}

export function KanbanView(props: ViewComponentProps) {
  const { baseId, table, view, config, update, canEdit, search, onOpenRecord, onCount } = props;
  const qc = useQueryClient();
  const k = config.kanban ?? { stackFieldId: null };
  const stackField = table.fields.find((f) => f.id === k.stackFieldId);
  const candidates = table.fields.filter((f) => f.type === "single_select" || f.type === "collaborator");
  const recordsQuery = useViewRecords(baseId, table, view?.id, config, search);
  const { records, queryKey } = recordsQuery;
  const writes = useRecordWrites(baseId, table.id, queryKey);
  const collabs = useCollaborators(baseId, stackField?.type === "collaborator");
  const [drag, setDrag] = useState<{ id: string; over: { stack: string; beforeId: string | null } | null } | null>(null);
  const [addingStack, setAddingStack] = useState(false);
  const [newStackName, setNewStackName] = useState("");

  useEffect(() => onCount?.(records.length), [records.length, onCount]);

  const stacks: Stack[] = useMemo(() => {
    if (!stackField) return [];
    const out: Stack[] = [{ key: UNCATEGORIZED, label: stackField.type === "collaborator" ? "Unassigned" : "Uncategorized" }];
    if (stackField.type === "single_select") {
      for (const o of selectOptions(stackField)) out.push({ key: o.id, label: o.label, color: o.color });
    } else {
      const seen = new Set<string>();
      for (const u of collabs.data ?? []) {
        seen.add(u.id);
        out.push({ key: u.id, label: u.name || u.email });
      }
      for (const r of records) {
        const v = r.fields[stackField.id];
        const first = (Array.isArray(v) ? v[0] : v) as { id: string; name?: string; email?: string } | undefined;
        if (first && typeof first === "object" && !seen.has(first.id)) {
          seen.add(first.id);
          out.push({ key: first.id, label: first.name ?? first.email ?? first.id });
        }
      }
    }
    return out;
  }, [stackField, collabs.data, records]);

  const byStack = useMemo(() => {
    const m = new Map<string, ViewRecord[]>();
    for (const s of stacks) m.set(s.key, []);
    if (!stackField) return m;
    for (const r of records) {
      const key = stackKeyOf(stackField, r);
      if (!m.has(key)) m.set(UNCATEGORIZED, m.get(UNCATEGORIZED) ?? []);
      (m.get(key) ?? m.get(UNCATEGORIZED)!).push(r);
    }
    return m;
  }, [records, stacks, stackField]);

  if (!stackField) {
    return (
      <div className={styles.emptyState}>
        <h3>Choose a field to stack your records by</h3>
        {candidates.length ? (
          <>
            <p>Kanban stacks records by a single select or collaborator field.</p>
            <select
              className={styles.select}
              disabled={!canEdit}
              aria-label="Stack by"
              value=""
              onChange={(e) => update({ kanban: { ...k, stackFieldId: e.target.value || null } })}
            >
              <option value="">Choose a field…</option>
              {candidates.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </>
        ) : (
          <p>Add a single select or collaborator field to this table to use a kanban view.</p>
        )}
      </div>
    );
  }

  const coverFieldId = k.coverFieldId ?? null;
  const cover = coverFieldId && records.some((r) => coverUrl(r, coverFieldId)) ? coverFieldId : null;
  const fieldsOnCard = cardFields(table, config, [stackField.id, coverFieldId]);
  const collapsed = new Set(k.collapsedStacks ?? []);
  const manualOrder = config.sorts.length === 0;

  function valueFor(stackKey: string): unknown {
    if (stackKey === UNCATEGORIZED) return stackField!.type === "collaborator" ? [] : null;
    return stackField!.type === "collaborator" ? [stackKey] : stackKey;
  }

  async function dropCard(stackKey: string, beforeId: string | null) {
    if (!drag) return;
    const rec = records.find((r) => r.id === drag.id);
    setDrag(null);
    if (!rec || !stackField) return;
    const fromKey = stackKeyOf(stackField, rec);
    if (beforeId === rec.id) return;
    const target = (byStack.get(stackKey) ?? []).filter((r) => r.id !== rec.id);
    const idx = beforeId ? target.findIndex((r) => r.id === beforeId) : target.length;
    const insertAt = idx < 0 ? target.length : idx;
    const after = target[insertAt - 1]?.id ?? null;
    const before = target[insertAt]?.id ?? null;
    // Optimistically reposition in cache.
    writes.setRecords((rs) => {
      const without = rs.filter((r) => r.id !== rec.id);
      const anchor = before ? without.findIndex((r) => r.id === before) : after ? without.findIndex((r) => r.id === after) + 1 : without.length;
      const moved = { ...rec };
      without.splice(anchor < 0 ? without.length : anchor, 0, moved);
      return without;
    });
    if (fromKey !== stackKey) {
      const value = valueFor(stackKey);
      let optimistic: unknown = value;
      if (stackField.type === "collaborator" && stackKey !== UNCATEGORIZED) {
        const u = (collabs.data ?? []).find((x) => x.id === stackKey);
        optimistic = [{ id: stackKey, name: u?.name ?? stackKey, email: u?.email ?? "" }];
      }
      await writes.patchFields(rec.id, { [stackField.id]: value }, { [stackField.id]: optimistic });
    }
    if (manualOrder && (after || before)) {
      await writes.move(rec.id, after ? { after } : { before });
    }
  }

  async function addCard(stackKey: string) {
    const rec = await writes.create({ [stackField!.id]: valueFor(stackKey) });
    if (rec) onOpenRecord(rec.id);
  }

  async function addStack() {
    const label = newStackName.trim();
    setAddingStack(false);
    setNewStackName("");
    if (!label || stackField?.type !== "single_select") return;
    const options = selectOptions(stackField);
    const color = COLOR_NAMES[options.length % COLOR_NAMES.length]!;
    const next = [...options.map((o) => ({ id: o.id, label: o.label, color: o.color ?? "gray" })), { id: randomOptionId(), label, color }];
    try {
      await request(`/v1/bases/${baseId}/tables/${table.id}/fields/${stackField.id}`, {
        method: "PATCH",
        json: { config: { ...(stackField.config ?? {}), options: next } },
      });
    } finally {
      void qc.invalidateQueries({ queryKey: ["bases", baseId] });
    }
  }

  function toggleCollapse(key: string) {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    update({ kanban: { ...k, collapsedStacks: [...next] } });
  }

  const visibleStacks = stacks.filter(
    (s) => !(k.hideEmptyStacks && (byStack.get(s.key)?.length ?? 0) === 0),
  );

  return (
    <div className={styles.kanbanWrap}>
      {writes.error ? <div className={styles.toastError}>{writes.error}</div> : null}
      <RecordsStatus {...statusProps(recordsQuery)} />
      <div className={styles.kanban}>
        {visibleStacks.map((s) => {
          const list = byStack.get(s.key) ?? [];
          const isCollapsed = collapsed.has(s.key);
          const c = colorOf(s.color);
          const over = drag?.over?.stack === s.key;
          if (isCollapsed) {
            return (
              <button
                key={s.key}
                type="button"
                className={styles.kanbanColCollapsed}
                onClick={() => toggleCollapse(s.key)}
                title={`Expand ${s.label}`}
                onDragOver={(e) => {
                  if (drag) e.preventDefault();
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void dropCard(s.key, null);
                }}
              >
                <span className={styles.stackChip} style={s.key === UNCATEGORIZED ? undefined : { background: c.bg, color: c.fg }}>
                  {s.label}
                </span>
                <span className={styles.muted}>{list.length}</span>
              </button>
            );
          }
          return (
            <section
              key={s.key}
              className={`${styles.kanbanCol} ${over ? styles.kanbanColOver : ""}`}
              aria-label={s.label}
              data-stack={s.key}
              onDragOver={(e) => {
                if (!drag) return;
                e.preventDefault();
                if (drag.over?.stack !== s.key) setDrag({ ...drag, over: { stack: s.key, beforeId: null } });
              }}
              onDrop={(e) => {
                e.preventDefault();
                void dropCard(s.key, drag?.over?.stack === s.key ? drag.over.beforeId : null);
              }}
            >
              <header className={styles.kanbanColHead}>
                <span
                  className={styles.stackChip}
                  style={s.key === UNCATEGORIZED ? undefined : { background: c.bg, color: c.fg }}
                >
                  {s.label}
                </span>
                <span className={styles.stackCount}>{list.length}</span>
                <button
                  type="button"
                  className={styles.iconBtn}
                  aria-label={`Collapse ${s.label}`}
                  onClick={() => toggleCollapse(s.key)}
                >
                  ⇤
                </button>
              </header>
              <div className={styles.kanbanCards}>
                {list.map((r) => (
                  <div
                    key={r.id}
                    className={drag?.over?.beforeId === r.id && drag.id !== r.id ? styles.dropBefore : undefined}
                    onDragOver={(e) => {
                      if (!drag) return;
                      e.preventDefault();
                      e.stopPropagation();
                      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                      const lower = e.clientY > rect.top + rect.height / 2;
                      const idx = list.indexOf(r);
                      const beforeId = lower ? (list[idx + 1]?.id ?? null) : r.id;
                      if (drag.over?.stack !== s.key || drag.over.beforeId !== beforeId)
                        setDrag({ ...drag, over: { stack: s.key, beforeId } });
                    }}
                  >
                    <RecordCard
                      table={table}
                      config={config}
                      record={r}
                      fields={fieldsOnCard}
                      {...(cover ? { cover: coverUrl(r, cover) } : {})}
                      coverHeight={140}
                      onOpen={() => onOpenRecord(r.id)}
                      draggable={canEdit}
                      dragging={drag?.id === r.id}
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", r.id);
                        setDrag({ id: r.id, over: null });
                      }}
                      onDragEnd={() => setDrag(null)}
                    />
                  </div>
                ))}
                <div
                  className={over && drag?.over?.beforeId === null ? styles.dropEnd : styles.dropTail}
                  onDragOver={(e) => {
                    if (!drag) return;
                    e.preventDefault();
                    e.stopPropagation();
                    if (drag.over?.stack !== s.key || drag.over.beforeId !== null)
                      setDrag({ ...drag, over: { stack: s.key, beforeId: null } });
                  }}
                />
              </div>
              {canEdit ? (
                <button type="button" className={styles.addCardBtn} onClick={() => void addCard(s.key)}>
                  + Add record
                </button>
              ) : null}
            </section>
          );
        })}
        {canEdit && stackField.type === "single_select" ? (
          <div className={styles.addStack}>
            {addingStack ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void addStack();
                }}
              >
                <input
                  className={styles.input}
                  autoFocus
                  placeholder="Stack name"
                  aria-label="New stack name"
                  value={newStackName}
                  onChange={(e) => setNewStackName(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setAddingStack(false);
                  }}
                  onBlur={() => void addStack()}
                />
              </form>
            ) : (
              <button type="button" className={styles.addStackBtn} onClick={() => setAddingStack(true)}>
                + Add stack
              </button>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
