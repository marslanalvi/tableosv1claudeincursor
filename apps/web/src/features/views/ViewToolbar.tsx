import { useMemo, useRef, useState, type ReactNode } from "react";
import type { FieldDto, FilterAst, TableDto, ViewDto } from "../../lib/api.ts";
import type { RowHeight, SortSpec, ViewConfig } from "../../lib/api-areas/views.ts";
import { FilterGroupEditor } from "./FilterBuilder.tsx";
import { Popover } from "./Popover.tsx";
import { VIEW_CREATE_OPTIONS, type ViewKind } from "./view-types.ts";
import {
  COLOR_NAMES,
  cleanFilter,
  colorOf,
  countConditions,
  orderedFields,
  toRootGroup,
  type FilterGroup,
} from "./view-utils.ts";
import styles from "./views.module.css";

type PanelId =
  | "hide"
  | "filter"
  | "group"
  | "sort"
  | "color"
  | "height"
  | "settings"
  | "search"
  | null;

const ROW_HEIGHTS: { id: RowHeight; label: string }[] = [
  { id: "short", label: "Short" },
  { id: "medium", label: "Medium" },
  { id: "tall", label: "Tall" },
  { id: "extra", label: "Extra tall" },
];

/* ------------------------------------------------------------------ */
/* Drag-to-reorder list helper (HTML5 DnD) */

function useDragList<T>(items: T[], onReorder: (next: T[]) => void) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);
  const handlers = (i: number) => ({
    draggable: true,
    onDragStart: (e: React.DragEvent) => {
      setDragIndex(i);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", String(i));
    },
    onDragOver: (e: React.DragEvent) => {
      if (dragIndex === null) return;
      e.preventDefault();
      setOverIndex(i);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      if (dragIndex === null || dragIndex === i) return;
      const next = [...items];
      const [moved] = next.splice(dragIndex, 1);
      next.splice(i, 0, moved!);
      onReorder(next);
      setDragIndex(null);
      setOverIndex(null);
    },
    onDragEnd: () => {
      setDragIndex(null);
      setOverIndex(null);
    },
    "data-drag-over": overIndex === i && dragIndex !== i ? "true" : undefined,
  });
  return handlers;
}

/* ------------------------------------------------------------------ */

function ToolbarButton({
  id,
  open,
  setOpen,
  label,
  activeLabel,
  active,
  tone,
  icon,
  children,
  width,
  align,
}: {
  id: Exclude<PanelId, null>;
  open: PanelId;
  setOpen: (p: PanelId) => void;
  label: string;
  activeLabel?: string;
  active?: boolean;
  tone?: "blue" | "green" | "purple" | "orange" | "pink" | "gray";
  icon: string;
  children: ReactNode;
  width?: number;
  align?: "left" | "right";
}) {
  const ref = useRef<HTMLButtonElement | null>(null);
  const isOpen = open === id;
  return (
    <span className={styles.toolWrap}>
      <button
        ref={ref}
        type="button"
        className={`${styles.toolBtn} ${active ? styles[`tone_${tone ?? "gray"}`] : ""} ${isOpen ? styles.toolBtnOpen : ""}`}
        aria-expanded={isOpen}
        aria-haspopup="dialog"
        data-panel={id}
        onClick={() => setOpen(isOpen ? null : id)}
      >
        <span aria-hidden className={styles.toolIcon}>
          {icon}
        </span>
        <span className={styles.toolLabel}>{active && activeLabel ? activeLabel : label}</span>
      </button>
      <Popover
        open={isOpen}
        onClose={() => setOpen(null)}
        anchorRef={ref}
        label={label}
        {...(width ? { width } : {})}
        {...(align ? { align } : {})}
      >
        {children}
      </Popover>
    </span>
  );
}

function FieldSelect({
  fields,
  value,
  onChange,
  placeholder = "Choose a field",
  allowNone,
  disabled,
  label,
}: {
  fields: FieldDto[];
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  placeholder?: string;
  allowNone?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  return (
    <select
      className={styles.select}
      value={value ?? ""}
      disabled={disabled}
      aria-label={label ?? placeholder}
      onChange={(e) => onChange(e.target.value || null)}
    >
      {allowNone || !value ? <option value="">{allowNone ? "None" : placeholder}</option> : null}
      {fields.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  );
}

/* ------------------------------------------------------------------ */
/* Panels */

function HideFieldsPanel({
  table,
  config,
  update,
  disabled,
  title = "Hide fields",
}: {
  table: TableDto;
  config: ViewConfig;
  update: (p: Partial<ViewConfig>) => void;
  disabled: boolean;
  title?: string;
}) {
  const [q, setQ] = useState("");
  const all = orderedFields(table, config);
  const primary = all.find((f) => f.id === table.primaryFieldId);
  const others = all.filter((f) => f.id !== table.primaryFieldId);
  const hidden = new Set(config.hiddenFieldIds);
  const shown = others.filter((f) => f.name.toLowerCase().includes(q.trim().toLowerCase()));
  const drag = useDragList(others, (next) =>
    update({ fieldOrder: [...(primary ? [primary.id] : []), ...next.map((f) => f.id)] }),
  );
  return (
    <div className={styles.panelBody}>
      <div className={styles.panelTitle}>{title}</div>
      <input
        className={styles.input}
        placeholder="Find a field"
        aria-label="Find a field"
        value={q}
        onChange={(e) => setQ(e.target.value)}
      />
      <div className={styles.fieldList}>
        {primary ? (
          <div className={styles.fieldRow} title="The primary field can't be hidden">
            <span className={styles.dragHandle} aria-hidden />
            <span className={styles.toggleLocked} aria-hidden />
            <span className={styles.fieldName}>{primary.name}</span>
          </div>
        ) : null}
        {shown.map((f) => {
          const i = others.indexOf(f);
          const on = !hidden.has(f.id);
          return (
            <div key={f.id} className={styles.fieldRow} {...(disabled || q ? {} : drag(i))}>
              <span className={styles.dragHandle} aria-hidden>
                ⋮⋮
              </span>
              <button
                type="button"
                role="switch"
                aria-checked={on}
                aria-label={`Show ${f.name}`}
                disabled={disabled}
                className={on ? styles.toggleOn : styles.toggleOff}
                onClick={() =>
                  update({
                    hiddenFieldIds: on
                      ? [...config.hiddenFieldIds, f.id]
                      : config.hiddenFieldIds.filter((x) => x !== f.id),
                  })
                }
              />
              <span className={styles.fieldName}>{f.name}</span>
            </div>
          );
        })}
      </div>
      {!disabled ? (
        <div className={styles.panelActionsSplit}>
          <button
            type="button"
            className={styles.secondaryBtn}
            onClick={() => update({ hiddenFieldIds: others.map((f) => f.id) })}
          >
            Hide all
          </button>
          <button type="button" className={styles.secondaryBtn} onClick={() => update({ hiddenFieldIds: [] })}>
            Show all
          </button>
        </div>
      ) : null}
    </div>
  );
}

function SortListPanel({
  title,
  fields,
  items,
  onChange,
  disabled,
  max,
  emptyText,
  addLabel,
}: {
  title: string;
  fields: FieldDto[];
  items: SortSpec[];
  onChange: (next: SortSpec[]) => void;
  disabled: boolean;
  max: number;
  emptyText: string;
  addLabel: string;
}) {
  const drag = useDragList(items, onChange);
  const used = new Set(items.map((s) => s.fieldId));
  const firstFree = fields.find((f) => !used.has(f.id));
  return (
    <div className={styles.panelBody}>
      <div className={styles.panelTitle}>{title}</div>
      {items.length === 0 ? <p className={styles.muted}>{emptyText}</p> : null}
      {items.map((s, i) => {
        const field = fields.find((f) => f.id === s.fieldId);
        const isText = !field || !["number", "currency", "percent", "rating", "duration", "date", "datetime", "checkbox", "autonumber", "count"].includes(field.type);
        return (
          <div key={`${s.fieldId}-${i}`} className={styles.sortRow} {...(disabled ? {} : drag(i))}>
            <span className={styles.dragHandle} aria-hidden>
              ⋮⋮
            </span>
            <FieldSelect
              fields={fields.filter((f) => f.id === s.fieldId || !used.has(f.id))}
              value={s.fieldId}
              disabled={disabled}
              label="Sort field"
              onChange={(id) => {
                if (!id) return;
                const next = [...items];
                next[i] = { ...s, fieldId: id };
                onChange(next);
              }}
            />
            <select
              className={styles.select}
              value={s.direction}
              disabled={disabled}
              aria-label="Direction"
              onChange={(e) => {
                const next = [...items];
                next[i] = { ...s, direction: e.target.value as "asc" | "desc" };
                onChange(next);
              }}
            >
              <option value="asc">{isText ? "A → Z" : "1 → 9"}</option>
              <option value="desc">{isText ? "Z → A" : "9 → 1"}</option>
            </select>
            {!disabled ? (
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Remove"
                onClick={() => onChange(items.filter((_, j) => j !== i))}
              >
                ✕
              </button>
            ) : null}
          </div>
        );
      })}
      {!disabled && items.length < max && firstFree ? (
        <div className={styles.panelActions}>
          <button
            type="button"
            className={styles.linkBtn}
            onClick={() => onChange([...items, { fieldId: firstFree.id, direction: "asc" }])}
          >
            + {addLabel}
          </button>
        </div>
      ) : null}
    </div>
  );
}

function ColorPanel({
  baseId,
  fields,
  config,
  update,
  disabled,
}: {
  baseId: string;
  fields: FieldDto[];
  config: ViewConfig;
  update: (p: Partial<ViewConfig>) => void;
  disabled: boolean;
}) {
  const selectFields = fields.filter((f) => f.type === "single_select");
  const color = config.color;
  return (
    <div className={styles.panelBody}>
      <div className={styles.panelTitle}>Color records</div>
      <div className={styles.segmented} role="radiogroup" aria-label="Color mode">
        {(
          [
            ["none", "None"],
            ["select", "Select field"],
            ["conditions", "Conditions"],
          ] as const
        ).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={color.mode === mode}
            disabled={disabled || (mode === "select" && selectFields.length === 0)}
            className={color.mode === mode ? styles.segOn : styles.seg}
            onClick={() => {
              if (mode === "none") update({ color: { mode: "none" } });
              else if (mode === "select")
                update({ color: { mode: "select", fieldId: selectFields[0]!.id } });
              else update({ color: { mode: "conditions", rules: color.mode === "conditions" ? color.rules : [] } });
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {color.mode === "select" ? (
        <label className={styles.formRow}>
          <span>Color by</span>
          <FieldSelect
            fields={selectFields}
            value={color.fieldId}
            disabled={disabled}
            onChange={(id) => id && update({ color: { mode: "select", fieldId: id } })}
          />
        </label>
      ) : null}
      {color.mode === "conditions" ? (
        <div className={styles.colorRules}>
          {color.rules.map((rule, i) => (
            <div key={i} className={styles.colorRule}>
              <div className={styles.colorRuleHead}>
                <span className={styles.swatches}>
                  {COLOR_NAMES.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      disabled={disabled}
                      className={rule.color === c ? styles.swatchOn : styles.swatch}
                      style={{ background: colorOf(c).bg }}
                      onClick={() => {
                        const rules = [...color.rules];
                        rules[i] = { ...rule, color: c };
                        update({ color: { mode: "conditions", rules } });
                      }}
                    />
                  ))}
                </span>
                {!disabled ? (
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label="Remove color rule"
                    onClick={() =>
                      update({ color: { mode: "conditions", rules: color.rules.filter((_, j) => j !== i) } })
                    }
                  >
                    ✕
                  </button>
                ) : null}
              </div>
              <FilterGroupEditor
                baseId={baseId}
                fields={fields}
                group={toRootGroup(rule.filter)}
                disabled={disabled}
                onChange={(g) => {
                  const rules = [...color.rules];
                  rules[i] = { ...rule, filter: g as FilterAst };
                  update({ color: { mode: "conditions", rules } });
                }}
              />
            </div>
          ))}
          {!disabled ? (
            <button
              type="button"
              className={styles.linkBtn}
              onClick={() =>
                update({
                  color: {
                    mode: "conditions",
                    rules: [
                      ...color.rules,
                      { color: COLOR_NAMES[color.rules.length % COLOR_NAMES.length]!, filter: { kind: "and", children: [] } },
                    ],
                  },
                })
              }
            >
              + Add color condition
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ViewSettingsPanel({
  kind,
  fields,
  config,
  update,
  disabled,
}: {
  kind: ViewKind;
  fields: FieldDto[];
  config: ViewConfig;
  update: (p: Partial<ViewConfig>) => void;
  disabled: boolean;
}) {
  const byType = (...types: string[]) => fields.filter((f) => types.includes(f.type));
  if (kind === "kanban") {
    const k = config.kanban ?? { stackFieldId: null };
    return (
      <div className={styles.panelBody}>
        <div className={styles.panelTitle}>Kanban settings</div>
        <label className={styles.formRow}>
          <span>Stack by</span>
          <FieldSelect
            fields={byType("single_select", "collaborator")}
            value={k.stackFieldId}
            disabled={disabled}
            onChange={(id) => update({ kanban: { ...k, stackFieldId: id } })}
          />
        </label>
        <label className={styles.formRow}>
          <span>Card cover</span>
          <FieldSelect
            fields={byType("attachment")}
            value={k.coverFieldId ?? null}
            allowNone
            disabled={disabled}
            onChange={(id) => update({ kanban: { ...k, coverFieldId: id } })}
          />
        </label>
        <label className={styles.checkLabel}>
          <input
            type="checkbox"
            disabled={disabled}
            checked={Boolean(k.hideEmptyStacks)}
            onChange={(e) => update({ kanban: { ...k, hideEmptyStacks: e.target.checked } })}
          />
          Hide empty stacks
        </label>
      </div>
    );
  }
  if (kind === "calendar") {
    const c = config.calendar ?? { dateFieldId: null };
    const dates = byType("date", "datetime", "created_time", "modified_time");
    return (
      <div className={styles.panelBody}>
        <div className={styles.panelTitle}>Calendar settings</div>
        <label className={styles.formRow}>
          <span>Date field</span>
          <FieldSelect fields={dates} value={c.dateFieldId} disabled={disabled} onChange={(id) => update({ calendar: { ...c, dateFieldId: id } })} />
        </label>
        <label className={styles.formRow}>
          <span>End date (optional)</span>
          <FieldSelect fields={dates.filter((f) => f.id !== c.dateFieldId)} value={c.endDateFieldId ?? null} allowNone disabled={disabled} onChange={(id) => update({ calendar: { ...c, endDateFieldId: id } })} />
        </label>
      </div>
    );
  }
  if (kind === "gallery") {
    const g = config.gallery ?? {};
    return (
      <div className={styles.panelBody}>
        <div className={styles.panelTitle}>Gallery settings</div>
        <label className={styles.formRow}>
          <span>Cover field</span>
          <FieldSelect fields={byType("attachment")} value={g.coverFieldId ?? null} allowNone disabled={disabled} onChange={(id) => update({ gallery: { ...g, coverFieldId: id } })} />
        </label>
        <label className={styles.formRow}>
          <span>Cover fit</span>
          <select className={styles.select} disabled={disabled} value={g.coverFit ?? "cover"} onChange={(e) => update({ gallery: { ...g, coverFit: e.target.value as "cover" | "contain" } })}>
            <option value="cover">Crop</option>
            <option value="contain">Fit</option>
          </select>
        </label>
      </div>
    );
  }
  if (kind === "timeline" || kind === "gantt") {
    const t = config.timeline ?? { startFieldId: null };
    const dates = byType("date", "datetime");
    return (
      <div className={styles.panelBody}>
        <div className={styles.panelTitle}>Timeline settings</div>
        <label className={styles.formRow}>
          <span>Start date</span>
          <FieldSelect fields={dates} value={t.startFieldId} disabled={disabled} onChange={(id) => update({ timeline: { ...t, startFieldId: id } })} />
        </label>
        <label className={styles.formRow}>
          <span>End date</span>
          <FieldSelect fields={dates.filter((f) => f.id !== t.startFieldId)} value={t.endFieldId ?? null} allowNone disabled={disabled} onChange={(id) => update({ timeline: { ...t, endFieldId: id } })} />
        </label>
      </div>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */

export function ViewToolbar({
  baseId,
  table,
  view,
  kind,
  config,
  update,
  canEdit,
  search,
  onSearchChange,
  onShare,
  recordCount,
  saveError,
}: {
  baseId: string;
  table: TableDto;
  view: ViewDto | undefined;
  kind: ViewKind;
  config: ViewConfig;
  update: (patch: Partial<ViewConfig>) => void;
  canEdit: boolean;
  search: string;
  onSearchChange: (q: string) => void;
  onShare?: () => void;
  recordCount?: number;
  saveError?: string | null;
}) {
  const [open, setOpen] = useState<PanelId>(null);
  const fields = useMemo(() => orderedFields(table, config), [table, config]);
  const disabled = !canEdit;
  const filterCount = countConditions(cleanFilter(config.filter));
  const hiddenCount = config.hiddenFieldIds.filter((id) => table.fields.some((f) => f.id === id)).length;
  const meta = VIEW_CREATE_OPTIONS.find((o) => o.id === kind);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const showHide = kind !== "form" && kind !== "calendar";
  const showGroup = kind === "grid" || kind === "list" || kind === "timeline" || kind === "gantt";
  const showColor = kind !== "form";
  const showHeight = kind === "grid";
  const showSettings = kind === "kanban" || kind === "calendar" || kind === "gallery" || kind === "timeline" || kind === "gantt";
  const showRecordControls = kind !== "form";

  return (
    <div className={styles.toolbarShell}>
      <div className={styles.toolbar} role="toolbar" aria-label="View toolbar">
        <div className={styles.viewTitle}>
          <span className={styles.viewTitleIcon} style={{ color: meta?.color }} aria-hidden>
            {meta?.icon ?? "▦"}
          </span>
          <span className={styles.viewName}>{view?.name ?? "Grid view"}</span>
          {view?.visibility === "locked" ? (
            <span className={styles.lockBadge} title="Locked view">
              🔒 Locked
            </span>
          ) : null}
          {view?.visibility === "personal" ? <span className={styles.metaBadge}>Personal</span> : null}
        </div>

        {showRecordControls ? (
          <div className={styles.toolRow}>
            {showHide ? (
              <ToolbarButton
                id="hide"
                open={open}
                setOpen={setOpen}
                icon="◐"
                label={kind === "grid" ? "Hide fields" : "Customize cards"}
                activeLabel={`${hiddenCount} hidden field${hiddenCount === 1 ? "" : "s"}`}
                active={hiddenCount > 0}
                tone="blue"
                width={320}
              >
                <HideFieldsPanel table={table} config={config} update={update} disabled={disabled} title={kind === "grid" ? "Hide fields" : "Fields shown on cards"} />
              </ToolbarButton>
            ) : null}
            <ToolbarButton
              id="filter"
              open={open}
              setOpen={setOpen}
              icon="⚲"
              label="Filter"
              activeLabel={`Filtered by ${filterCount} condition${filterCount === 1 ? "" : "s"}`}
              active={filterCount > 0}
              tone="green"
              width={640}
            >
              <div className={styles.panelBody}>
                <div className={styles.panelTitle}>In this view, show records</div>
                <FilterGroupEditor
                  baseId={baseId}
                  fields={fields}
                  group={toRootGroup(config.filter)}
                  disabled={disabled}
                  onChange={(g: FilterGroup) =>
                    update({ filter: g.children.length ? (g as FilterAst) : null })
                  }
                />
              </div>
            </ToolbarButton>
            {showGroup ? (
              <ToolbarButton
                id="group"
                open={open}
                setOpen={setOpen}
                icon="☰"
                label="Group"
                activeLabel={`Grouped by ${config.groups.length} field${config.groups.length === 1 ? "" : "s"}`}
                active={config.groups.length > 0}
                tone="purple"
                width={420}
              >
                <SortListPanel
                  title="Group by"
                  fields={fields}
                  items={config.groups}
                  onChange={(groups) => update({ groups })}
                  disabled={disabled}
                  max={3}
                  emptyText="No groups applied. Group records by up to 3 fields."
                  addLabel="Add subgroup"
                />
              </ToolbarButton>
            ) : null}
            <ToolbarButton
              id="sort"
              open={open}
              setOpen={setOpen}
              icon="⇅"
              label="Sort"
              activeLabel={`Sorted by ${config.sorts.length} field${config.sorts.length === 1 ? "" : "s"}`}
              active={config.sorts.length > 0}
              tone="orange"
              width={420}
            >
              <SortListPanel
                title="Sort by"
                fields={fields}
                items={config.sorts}
                onChange={(sorts) => update({ sorts })}
                disabled={disabled}
                max={10}
                emptyText="No sorts applied. Records use their manual order."
                addLabel="Add another sort"
              />
            </ToolbarButton>
            {showColor ? (
              <ToolbarButton
                id="color"
                open={open}
                setOpen={setOpen}
                icon="◍"
                label="Color"
                activeLabel={config.color.mode === "select" ? "Colored by field" : "Colored by conditions"}
                active={config.color.mode !== "none"}
                tone="pink"
                width={560}
              >
                <ColorPanel baseId={baseId} fields={fields} config={config} update={update} disabled={disabled} />
              </ToolbarButton>
            ) : null}
            {showHeight ? (
              <ToolbarButton id="height" open={open} setOpen={setOpen} icon="↕" label="Row height" width={200}>
                <div className={styles.panelBody}>
                  <div className={styles.panelTitle}>Row height</div>
                  {ROW_HEIGHTS.map((h) => (
                    <button
                      key={h.id}
                      type="button"
                      role="menuitemradio"
                      aria-checked={config.rowHeight === h.id}
                      disabled={disabled}
                      className={config.rowHeight === h.id ? styles.menuItemOn : styles.menuItem}
                      onClick={() => update({ rowHeight: h.id })}
                    >
                      {h.label}
                    </button>
                  ))}
                </div>
              </ToolbarButton>
            ) : null}
            {showSettings ? (
              <ToolbarButton id="settings" open={open} setOpen={setOpen} icon="⚙" label="Settings" width={340}>
                <ViewSettingsPanel kind={kind} fields={fields} config={config} update={update} disabled={disabled} />
              </ToolbarButton>
            ) : null}
          </div>
        ) : (
          <div className={styles.toolRow} />
        )}

        <div className={styles.toolRight}>
          {saveError ? <span className={styles.errorText}>Not saved: {saveError}</span> : null}
          {typeof recordCount === "number" && showRecordControls ? (
            <span className={styles.muted}>
              {recordCount} record{recordCount === 1 ? "" : "s"}
            </span>
          ) : null}
          {showRecordControls ? (
            <span className={styles.searchWrap}>
              {open === "search" || search ? (
                <input
                  ref={searchRef}
                  autoFocus
                  className={styles.searchInput}
                  placeholder="Find in view"
                  aria-label="Search records"
                  value={search}
                  onChange={(e) => onSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      onSearchChange("");
                      setOpen(null);
                    }
                  }}
                  onBlur={() => {
                    if (!search) setOpen(null);
                  }}
                />
              ) : null}
              <button
                type="button"
                className={styles.toolBtn}
                aria-label={search ? "Clear search" : "Search"}
                onClick={() => {
                  if (search) {
                    onSearchChange("");
                    setOpen(null);
                  } else setOpen(open === "search" ? null : "search");
                }}
              >
                {search ? "✕" : "⌕"}
              </button>
            </span>
          ) : null}
          {onShare ? (
            <button type="button" className={styles.toolBtn} onClick={onShare}>
              Share view
            </button>
          ) : null}
        </div>
      </div>
      {!canEdit ? (
        <div className={styles.readOnlyBar}>
          This view is {view?.visibility === "locked" ? "locked" : "read-only"} — its filters, sorts and layout can't be changed.
        </div>
      ) : null}
    </div>
  );
}
