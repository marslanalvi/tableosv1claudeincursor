import type { FieldDto, FilterAst } from "../../lib/api.ts";
import { ValueEditor } from "./field-value.tsx";
import {
  DATE_FIELD_TYPES,
  MULTI_VALUE_OPS,
  RELATIVE_DATES,
  VALUELESS_OPS,
  WITHIN_RANGES,
  defaultFilterValue,
  operatorLabel,
  operatorsForFieldType,
  type FilterCondition,
  type FilterGroup,
} from "./view-utils.ts";
import styles from "./views.module.css";

const MAX_DEPTH = 3;

function toIds(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  return arr.map((x) => (typeof x === "string" ? x : String((x as { id?: string }).id ?? "")));
}

function ConditionValue({
  baseId,
  field,
  cond,
  onChange,
  disabled,
}: {
  baseId: string;
  field: FieldDto | undefined;
  cond: FilterCondition;
  onChange: (value: unknown) => void;
  disabled: boolean;
}) {
  if (!field || VALUELESS_OPS.has(cond.op)) return <span className={styles.condValueEmpty} />;
  if (DATE_FIELD_TYPES.has(field.type)) {
    if (cond.op === "isWithin") {
      const v = (cond.value ?? { range: "pastWeek" }) as { range: string; n?: number };
      return (
        <span className={styles.condValue}>
          <select
            className={styles.select}
            disabled={disabled}
            value={v.range}
            onChange={(e) => onChange({ ...v, range: e.target.value })}
          >
            {WITHIN_RANGES.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label}
              </option>
            ))}
          </select>
          {v.range === "pastNDays" || v.range === "nextNDays" ? (
            <input
              className={styles.inputCompact}
              type="number"
              min={1}
              disabled={disabled}
              style={{ width: 64 }}
              value={v.n ?? 7}
              onChange={(e) => onChange({ ...v, n: Number(e.target.value) || 1 })}
            />
          ) : null}
        </span>
      );
    }
    const v =
      typeof cond.value === "string"
        ? { relative: "exactDate", date: cond.value }
        : ((cond.value ?? { relative: "today" }) as { relative: string; date?: string });
    return (
      <span className={styles.condValue}>
        <select
          className={styles.select}
          disabled={disabled}
          value={v.relative}
          onChange={(e) =>
            onChange(
              e.target.value === "exactDate"
                ? { relative: "exactDate", date: v.date ?? new Date().toISOString().slice(0, 10) }
                : { relative: e.target.value },
            )
          }
        >
          {RELATIVE_DATES.map((r) => (
            <option key={r.id} value={r.id}>
              {r.label}
            </option>
          ))}
        </select>
        {v.relative === "exactDate" ? (
          <input
            className={styles.inputCompact}
            type="date"
            disabled={disabled}
            value={v.date ?? ""}
            onChange={(e) => onChange({ relative: "exactDate", date: e.target.value })}
          />
        ) : null}
      </span>
    );
  }
  if (field.type === "checkbox") {
    return (
      <select
        className={styles.select}
        disabled={disabled}
        value={cond.value === false ? "false" : "true"}
        onChange={(e) => onChange(e.target.value === "true")}
      >
        <option value="true">checked</option>
        <option value="false">unchecked</option>
      </select>
    );
  }
  if (field.type === "single_select" || field.type === "multi_select") {
    const multi = MULTI_VALUE_OPS.has(cond.op);
    const editorField: FieldDto = { ...field, type: multi ? "multi_select" : "single_select" };
    return (
      <span className={styles.condValue}>
        <ValueEditor
          baseId={baseId}
          field={editorField}
          compact
          value={multi ? toIds(cond.value) : typeof cond.value === "string" ? cond.value : ""}
          onChange={(v) => onChange(multi ? toIds(v) : v ?? "")}
        />
      </span>
    );
  }
  if (field.type === "collaborator" || field.type === "created_by" || field.type === "modified_by") {
    const editorField: FieldDto = {
      ...field,
      type: "collaborator",
      config: { ...(field.config ?? {}), allowMultiple: true } as FieldDto["config"],
    };
    return (
      <span className={styles.condValue}>
        <ValueEditor
          baseId={baseId}
          field={editorField}
          compact
          value={toIds(cond.value)}
          onChange={(v) => onChange(toIds(v))}
        />
      </span>
    );
  }
  const numeric = ["number", "currency", "percent", "rating", "duration", "autonumber", "count"].includes(
    field.type,
  );
  return (
    <input
      className={styles.inputCompact}
      disabled={disabled}
      type={numeric ? "number" : "text"}
      placeholder="Enter a value"
      value={cond.value === undefined || cond.value === null ? "" : String(cond.value)}
      onChange={(e) =>
        onChange(numeric ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value)
      }
    />
  );
}

export function FilterGroupEditor({
  baseId,
  fields,
  group,
  onChange,
  onRemove,
  depth = 0,
  disabled = false,
}: {
  baseId: string;
  fields: FieldDto[];
  group: FilterGroup;
  onChange: (g: FilterGroup) => void;
  onRemove?: () => void;
  depth?: number;
  disabled?: boolean;
}) {
  const setChild = (i: number, child: FilterAst | null) => {
    const children = [...group.children];
    if (child === null) children.splice(i, 1);
    else children[i] = child;
    onChange({ ...group, children });
  };
  const addCondition = () => {
    const f = fields[0];
    if (!f) return;
    const op = operatorsForFieldType(f.type)[0] ?? "contains";
    const value = defaultFilterValue(f, op);
    const cond: FilterCondition = { kind: "condition", fieldId: f.id, op, ...(value !== undefined ? { value } : {}) };
    onChange({ ...group, children: [...group.children, cond] });
  };
  const addGroup = () => {
    onChange({ ...group, children: [...group.children, { kind: "and", children: [] }] });
  };

  return (
    <div className={depth > 0 ? styles.filterGroupNested : styles.filterGroup}>
      {depth > 0 ? (
        <div className={styles.filterGroupHead}>
          <span className={styles.muted}>Condition group</span>
          {onRemove && !disabled ? (
            <button type="button" className={styles.iconBtn} aria-label="Remove group" onClick={onRemove}>
              ✕
            </button>
          ) : null}
        </div>
      ) : null}
      {group.children.length === 0 ? (
        <p className={styles.muted}>
          {depth === 0 ? "No filter conditions are applied to this view." : "Empty group"}
        </p>
      ) : null}
      {group.children.map((child, i) => {
        const conj =
          i === 0 ? (
            <span className={styles.conj}>Where</span>
          ) : i === 1 ? (
            <select
              className={styles.selectConj}
              disabled={disabled}
              value={group.kind}
              aria-label="Combine conditions with"
              onChange={(e) => onChange({ ...group, kind: e.target.value as "and" | "or" })}
            >
              <option value="and">and</option>
              <option value="or">or</option>
            </select>
          ) : (
            <span className={styles.conj}>{group.kind}</span>
          );
        if (child.kind !== "condition") {
          return (
            <div key={i} className={styles.condRow}>
              {conj}
              <FilterGroupEditor
                baseId={baseId}
                fields={fields}
                group={child as FilterGroup}
                depth={depth + 1}
                disabled={disabled}
                onChange={(g) => setChild(i, g)}
                onRemove={() => setChild(i, null)}
              />
            </div>
          );
        }
        const field = fields.find((f) => f.id === child.fieldId);
        const ops = field ? operatorsForFieldType(field.type) : [];
        return (
          <div key={i} className={styles.condRow} data-testid="filter-condition">
            {conj}
            <select
              className={styles.select}
              disabled={disabled}
              aria-label="Field"
              value={child.fieldId}
              onChange={(e) => {
                const f = fields.find((x) => x.id === e.target.value);
                const nextOps = f ? operatorsForFieldType(f.type) : [];
                const op = nextOps.includes(child.op as never) ? child.op : (nextOps[0] ?? "contains");
                const value = defaultFilterValue(f, op);
                setChild(i, { kind: "condition", fieldId: e.target.value, op, ...(value !== undefined ? { value } : {}) });
              }}
            >
              {fields.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
            <select
              className={styles.select}
              disabled={disabled}
              aria-label="Operator"
              value={child.op}
              onChange={(e) => {
                const op = e.target.value;
                const keep =
                  !VALUELESS_OPS.has(op) &&
                  MULTI_VALUE_OPS.has(op) === MULTI_VALUE_OPS.has(child.op) &&
                  (op === "isWithin") === (child.op === "isWithin") &&
                  child.value !== undefined;
                const value = keep ? child.value : defaultFilterValue(field, op);
                setChild(i, { kind: "condition", fieldId: child.fieldId, op, ...(value !== undefined ? { value } : {}) });
              }}
            >
              {ops.map((op) => (
                <option key={op} value={op}>
                  {operatorLabel(op)}
                </option>
              ))}
            </select>
            <ConditionValue
              baseId={baseId}
              field={field}
              cond={child}
              disabled={disabled}
              onChange={(value) => setChild(i, { ...child, value })}
            />
            {!disabled ? (
              <button
                type="button"
                className={styles.iconBtn}
                aria-label="Remove condition"
                onClick={() => setChild(i, null)}
              >
                ✕
              </button>
            ) : null}
          </div>
        );
      })}
      {!disabled ? (
        <div className={styles.panelActions}>
          <button type="button" className={styles.linkBtn} onClick={addCondition}>
            + Add condition
          </button>
          {depth < MAX_DEPTH - 1 ? (
            <button type="button" className={styles.linkBtn} onClick={addGroup}>
              + Add condition group
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
