import { useEffect, useState } from "react";
import type { FieldDto, FilterAst, TableDto } from "../../lib/api.ts";
import type {
  AggFn,
  DataSource,
  ElementField,
  InterfaceElement,
  InterfacePage,
} from "../../lib/api-areas/interfaces.ts";
import { FilterGroupEditor } from "../views/FilterBuilder.tsx";
import { cleanFilter, countConditions, isEditableField, toRootGroup, type FilterGroup } from "../views/view-utils.ts";
import { ELEMENT_LABEL, groupableFields, isNumericField, makeElement, starterFields } from "./element-defaults.ts";
import styles from "./interfaces.module.css";

const WIDTHS = [
  { w: 3, label: "Quarter" },
  { w: 4, label: "Third" },
  { w: 6, label: "Half" },
  { w: 8, label: "Two thirds" },
  { w: 12, label: "Full width" },
];

const AGGS: Array<{ agg: AggFn; label: string; numeric: boolean }> = [
  { agg: "count", label: "Count of records", numeric: false },
  { agg: "sum", label: "Sum", numeric: true },
  { agg: "avg", label: "Average", numeric: true },
  { agg: "min", label: "Minimum", numeric: true },
  { agg: "max", label: "Maximum", numeric: true },
  { agg: "count_unique", label: "Unique values", numeric: false },
];

const SAFE_URL = /^(https:|mailto:|tel:)/i;

function Row({ label, children, htmlFor }: { label: string; children: React.ReactNode; htmlFor?: string }) {
  return (
    <div className={styles.inspRow}>
      <label className={styles.inspLabel} htmlFor={htmlFor}>
        {label}
      </label>
      {children}
    </div>
  );
}

function Check({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className={styles.inspCheck}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

function FieldPicker({
  table,
  value,
  onChange,
  extra,
}: {
  table: TableDto;
  value: ElementField[];
  onChange: (v: ElementField[]) => void;
  extra?: "editable" | "required";
}) {
  const byId = new Map(table.fields.map((f) => [f.id, f]));
  const chosen = value.filter((v) => byId.has(v.fieldId));
  const rest = table.fields.filter((f) => !chosen.some((c) => c.fieldId === f.id));
  const move = (i: number, d: -1 | 1) => {
    const next = [...chosen];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j]!, next[i]!];
    onChange(next);
  };
  return (
    <div className={styles.fieldPicker} role="group" aria-label="Fields">
      {chosen.map((c, i) => {
        const f = byId.get(c.fieldId)!;
        const canEdit = isEditableField(f);
        return (
          <div key={c.fieldId} className={styles.fieldPickRow}>
            <input
              type="checkbox"
              checked
              aria-label={`Show ${f.name}`}
              onChange={() => onChange(chosen.filter((x) => x.fieldId !== c.fieldId))}
            />
            <span className={styles.fieldPickName}>{f.name}</span>
            {extra === "editable" && canEdit ? (
              <label className={styles.fieldPickFlag}>
                <input
                  type="checkbox"
                  checked={c.editable}
                  onChange={(e) => onChange(chosen.map((x) => (x.fieldId === c.fieldId ? { ...x, editable: e.target.checked } : x)))}
                />
                Editable
              </label>
            ) : null}
            {extra === "required" ? (
              <label className={styles.fieldPickFlag}>
                <input
                  type="checkbox"
                  checked={Boolean(c.required)}
                  onChange={(e) => onChange(chosen.map((x) => (x.fieldId === c.fieldId ? { ...x, required: e.target.checked } : x)))}
                />
                Required
              </label>
            ) : null}
            <button type="button" className={styles.miniBtn} aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => move(i, -1)}>
              ↑
            </button>
            <button
              type="button"
              className={styles.miniBtn}
              aria-label={`Move ${f.name} down`}
              disabled={i === chosen.length - 1}
              onClick={() => move(i, 1)}
            >
              ↓
            </button>
          </div>
        );
      })}
      {rest
        .filter((f) => extra !== "required" || isEditableField(f))
        .map((f) => (
          <div key={f.id} className={styles.fieldPickRow} data-off>
            <input
              type="checkbox"
              checked={false}
              aria-label={`Show ${f.name}`}
              onChange={() => onChange([...chosen, { fieldId: f.id, editable: extra === "editable" ? isEditableField(f) : extra === "required" }])}
            />
            <span className={styles.fieldPickName}>{f.name}</span>
          </div>
        ))}
    </div>
  );
}

function FilterSection({
  baseId,
  elementId,
  table,
  filter,
  onChange,
}: {
  baseId: string;
  elementId: string;
  table: TableDto;
  filter: DataSource["filter"];
  onChange: (f: FilterAst | null) => void;
}) {
  const [group, setGroup] = useState<FilterGroup>(() => toRootGroup(filter ?? null));
  useEffect(() => setGroup(toRootGroup(filter ?? null)), [elementId, table.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const n = countConditions(filter ?? null);
  return (
    <details className={styles.inspDetails} open={n > 0}>
      <summary>Filter{n ? ` · ${n}` : ""}</summary>
      <p className={styles.inspHint}>Only matching records are shown. Viewers can't change or bypass this filter.</p>
      <FilterGroupEditor
        baseId={baseId}
        fields={table.fields}
        group={group}
        onChange={(g) => {
          setGroup(g);
          onChange(cleanFilter(g));
        }}
      />
    </details>
  );
}

function SourceSection({
  baseId,
  el,
  tables,
  source,
  onTable,
  onSource,
}: {
  baseId: string;
  el: InterfaceElement;
  tables: TableDto[];
  source: DataSource;
  onTable: (t: TableDto) => void;
  onSource: (s: DataSource) => void;
}) {
  const table = tables.find((t) => t.id === source.tableId);
  return (
    <>
      <Row label="Table" htmlFor="insp-table">
        <select
          id="insp-table"
          className={styles.input}
          value={source.tableId}
          onChange={(e) => {
            const t = tables.find((x) => x.id === e.target.value);
            if (t) onTable(t);
          }}
        >
          {!table ? <option value={source.tableId}>(deleted table)</option> : null}
          {tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </Row>
      {table ? (
        <Row label="Records from view" htmlFor="insp-view">
          <select
            id="insp-view"
            className={styles.input}
            value={source.baseViewId ?? ""}
            onChange={(e) => onSource({ ...source, baseViewId: e.target.value || null })}
          >
            <option value="">All records</option>
            {table.views
              .filter((v) => v.visibility !== "personal")
              .map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
          </select>
        </Row>
      ) : null}
      {table ? (
        <FilterSection baseId={baseId} elementId={el.id} table={table} filter={source.filter} onChange={(filter) => onSource({ ...source, filter })} />
      ) : null}
    </>
  );
}

function sameIds(el: InterfaceElement, next: InterfaceElement): InterfaceElement {
  return { ...next, id: el.id, layout: el.layout, ...(el.title !== undefined ? { title: el.title } : {}) } as InterfaceElement;
}

export function Inspector({
  baseId,
  el,
  tables,
  elements,
  pages,
  currentPageId,
  onChange,
  onRemove,
  onClose,
}: {
  baseId: string;
  el: InterfaceElement;
  tables: TableDto[];
  elements: InterfaceElement[];
  pages: InterfacePage[];
  currentPageId: string;
  onChange: (el: InterfaceElement) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<InterfaceElement>) => onChange({ ...el, ...patch } as InterfaceElement);
  const setConfig = (config: object) => onChange({ ...el, config } as InterfaceElement);
  const retable = (t: TableDto) => {
    const fresh = makeElement(el.type, t, elements.filter((e) => e.id !== el.id));
    if (fresh) onChange(sameIds(el, fresh));
  };
  const [url, setUrl] = useState("");
  useEffect(() => {
    if (el.type === "button") {
      const a = el.config.actions[0];
      setUrl(a?.kind === "open_url" ? a.urlTemplate : "https://");
    }
  }, [el.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const numericOf = (t: TableDto | undefined): FieldDto[] => (t ? t.fields.filter(isNumericField) : []);

  return (
    <div className={styles.inspector} aria-label={`${ELEMENT_LABEL[el.type]} settings`}>
      <div className={styles.inspHead}>
        <span className={styles.inspTitle}>{ELEMENT_LABEL[el.type]}</span>
        <button type="button" className={styles.iconBtn} aria-label="Close settings" onClick={onClose}>
          ×
        </button>
      </div>

      {el.type !== "divider" ? (
        <Row label="Title" htmlFor="insp-title">
          <input
            id="insp-title"
            className={styles.input}
            value={el.title ?? ""}
            placeholder="Untitled"
            maxLength={255}
            onChange={(e) => set({ title: e.target.value })}
          />
        </Row>
      ) : null}

      <Row label="Width" htmlFor="insp-width">
        <select
          id="insp-width"
          className={styles.input}
          value={el.layout.lg.w}
          onChange={(e) => set({ layout: { ...el.layout, lg: { ...el.layout.lg, w: Number(e.target.value) } } })}
        >
          {WIDTHS.map((w) => (
            <option key={w.w} value={w.w}>
              {w.label}
            </option>
          ))}
        </select>
      </Row>

      {el.type === "text" ? (
        <Row label="Text" htmlFor="insp-body">
          <textarea
            id="insp-body"
            className={styles.textarea}
            rows={8}
            value={el.config.body}
            onChange={(e) => setConfig({ body: e.target.value })}
          />
          <p className={styles.inspHint}>Use # for headings, - for bullets and **bold**.</p>
        </Row>
      ) : null}

      {el.type === "metric" ? (
        <>
          <SourceSection baseId={baseId} el={el} tables={tables} source={el.config.source} onTable={retable} onSource={(source) => setConfig({ ...el.config, source })} />
          <Row label="Calculate" htmlFor="insp-agg">
            <select
              id="insp-agg"
              className={styles.input}
              value={el.config.measure.agg}
              onChange={(e) => {
                const agg = e.target.value as AggFn;
                const t = tables.find((x) => x.id === el.config.source.tableId);
                const needs = AGGS.find((a) => a.agg === agg)!;
                const fieldId =
                  agg === "count" ? null : needs.numeric ? (numericOf(t)[0]?.id ?? null) : (el.config.measure.fieldId ?? t?.primaryFieldId ?? null);
                setConfig({ ...el.config, measure: { agg, fieldId } });
              }}
            >
              {AGGS.map((a) => (
                <option key={a.agg} value={a.agg} disabled={a.numeric && numericOf(tables.find((x) => x.id === el.config.source.tableId)).length === 0}>
                  {a.label}
                </option>
              ))}
            </select>
          </Row>
          {el.config.measure.agg !== "count" ? (
            <Row label="Field" htmlFor="insp-mfield">
              <select
                id="insp-mfield"
                className={styles.input}
                value={el.config.measure.fieldId ?? ""}
                onChange={(e) => setConfig({ ...el.config, measure: { ...el.config.measure, fieldId: e.target.value } })}
              >
                {(AGGS.find((a) => a.agg === el.config.measure.agg)?.numeric
                  ? numericOf(tables.find((x) => x.id === el.config.source.tableId))
                  : (tables.find((x) => x.id === el.config.source.tableId)?.fields ?? [])
                ).map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name}
                  </option>
                ))}
              </select>
            </Row>
          ) : null}
          <Row label="Format" htmlFor="insp-format">
            <select
              id="insp-format"
              className={styles.input}
              value={el.config.format?.style ?? "number"}
              onChange={(e) =>
                setConfig({ ...el.config, format: { style: e.target.value as "number" | "currency" | "percent", ...(e.target.value === "currency" ? { currencyCode: "USD" } : {}) } })
              }
            >
              <option value="number">Number</option>
              <option value="currency">Currency (USD)</option>
              <option value="percent">Percent</option>
            </select>
          </Row>
        </>
      ) : null}

      {el.type === "chart" ? (
        (() => {
          const t = tables.find((x) => x.id === el.config.source.tableId);
          const m = el.config.measures[0] ?? { agg: "count" as AggFn };
          return (
            <>
              <SourceSection baseId={baseId} el={el} tables={tables} source={el.config.source} onTable={retable} onSource={(source) => setConfig({ ...el.config, source })} />
              <Row label="Chart type" htmlFor="insp-kind">
                <select
                  id="insp-kind"
                  className={styles.input}
                  value={el.config.kind}
                  onChange={(e) => setConfig({ ...el.config, kind: e.target.value })}
                >
                  <option value="bar">Bar</option>
                  <option value="line">Line</option>
                  <option value="pie">Pie</option>
                  <option value="donut">Donut</option>
                </select>
              </Row>
              <Row label="Group by" htmlFor="insp-x">
                <select
                  id="insp-x"
                  className={styles.input}
                  value={el.config.x.fieldId}
                  onChange={(e) => setConfig({ ...el.config, x: { ...el.config.x, fieldId: e.target.value } })}
                >
                  {(t ? groupableFields(t) : []).map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
              </Row>
              <Row label="Value" htmlFor="insp-cagg">
                <select
                  id="insp-cagg"
                  className={styles.input}
                  value={m.agg === "count" ? "count" : `${m.agg}:${m.fieldId ?? ""}`}
                  onChange={(e) => {
                    const [agg, fieldId] = e.target.value.split(":") as [AggFn, string | undefined];
                    setConfig({ ...el.config, measures: [agg === "count" ? { agg } : { agg, fieldId: fieldId ?? null }] });
                  }}
                >
                  <option value="count">Count of records</option>
                  {numericOf(t).flatMap((f) =>
                    (["sum", "avg"] as const).map((agg) => (
                      <option key={`${agg}:${f.id}`} value={`${agg}:${f.id}`}>
                        {agg === "sum" ? "Sum" : "Average"} of {f.name}
                      </option>
                    )),
                  )}
                </select>
              </Row>
              <Row label="Sort" htmlFor="insp-sort">
                <select
                  id="insp-sort"
                  className={styles.input}
                  value={el.config.x.sort}
                  onChange={(e) => setConfig({ ...el.config, x: { ...el.config.x, sort: e.target.value } })}
                >
                  <option value="label">By label</option>
                  <option value="value_desc">Largest first</option>
                  <option value="value_asc">Smallest first</option>
                </select>
              </Row>
            </>
          );
        })()
      ) : null}

      {el.type === "table" || el.type === "record_list" || el.type === "gallery" ? (
        (() => {
          const t = tables.find((x) => x.id === el.config.dataSource.tableId);
          return (
            <>
              <SourceSection
                baseId={baseId}
                el={el}
                tables={tables}
                source={el.config.dataSource}
                onTable={retable}
                onSource={(dataSource) => setConfig({ ...el.config, dataSource })}
              />
              {t ? (
                <details className={styles.inspDetails} open>
                  <summary>Fields · {el.config.fields.length}</summary>
                  <p className={styles.inspHint}>Only these fields are sent to people using the interface.</p>
                  <FieldPicker table={t} value={el.config.fields} onChange={(fields) => setConfig({ ...el.config, fields })} />
                </details>
              ) : null}
              <div className={styles.inspChecks}>
                <Check label="Show a search box" checked={el.config.searchable} onChange={(searchable) => setConfig({ ...el.config, searchable })} />
                <Check
                  label="Allow creating records"
                  checked={el.config.permissions.allowCreate}
                  onChange={(allowCreate) => setConfig({ ...el.config, permissions: { ...el.config.permissions, allowCreate } })}
                />
                <Check
                  label="Open records on click"
                  checked={el.config.permissions.allowOpenRecord}
                  onChange={(allowOpenRecord) => setConfig({ ...el.config, permissions: { ...el.config.permissions, allowOpenRecord } })}
                />
              </div>
            </>
          );
        })()
      ) : null}

      {el.type === "record_detail" ? (
        (() => {
          const sources = elements.filter(
            (e): e is Extract<InterfaceElement, { type: "table" | "record_list" | "gallery" }> =>
              e.type === "table" || e.type === "record_list" || e.type === "gallery",
          );
          const t = tables.find((x) => x.id === el.config.dataSource.tableId);
          return (
            <>
              <Row label="Show the record selected in" htmlFor="insp-src">
                <select
                  id="insp-src"
                  className={styles.input}
                  value={el.config.dataSource.recordContext.elementId}
                  onChange={(e) => {
                    const src = sources.find((s) => s.id === e.target.value);
                    if (!src) return;
                    const tbl = tables.find((x) => x.id === src.config.dataSource.tableId);
                    setConfig({
                      dataSource: { tableId: src.config.dataSource.tableId, recordContext: { kind: "selected_in_element", elementId: src.id } },
                      fields: tbl ? starterFields(tbl, 8, true) : [],
                    });
                  }}
                >
                  {!sources.some((s) => s.id === el.config.dataSource.recordContext.elementId) ? <option value="">(removed element)</option> : null}
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title || ELEMENT_LABEL[s.type]}
                    </option>
                  ))}
                </select>
              </Row>
              {t ? (
                <details className={styles.inspDetails} open>
                  <summary>Fields · {el.config.fields.length}</summary>
                  <FieldPicker table={t} value={el.config.fields} onChange={(fields) => setConfig({ ...el.config, fields })} extra="editable" />
                </details>
              ) : null}
            </>
          );
        })()
      ) : null}

      {el.type === "form" ? (
        (() => {
          const t = tables.find((x) => x.id === el.config.tableId);
          return (
            <>
              <Row label="Adds records to" htmlFor="insp-ftable">
                <select
                  id="insp-ftable"
                  className={styles.input}
                  value={el.config.tableId}
                  onChange={(e) => {
                    const nt = tables.find((x) => x.id === e.target.value);
                    if (nt) retable(nt);
                  }}
                >
                  {tables.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.name}
                    </option>
                  ))}
                </select>
              </Row>
              {t ? (
                <details className={styles.inspDetails} open>
                  <summary>Questions · {el.config.fields.length}</summary>
                  <FieldPicker
                    table={t}
                    value={el.config.fields}
                    onChange={(fields) => setConfig({ ...el.config, fields: fields.map((f) => ({ ...f, editable: true })) })}
                    extra="required"
                  />
                </details>
              ) : null}
              <Row label="Description" htmlFor="insp-fdesc">
                <textarea
                  id="insp-fdesc"
                  className={styles.textarea}
                  rows={2}
                  value={el.description ?? ""}
                  maxLength={1000}
                  onChange={(e) => set({ description: e.target.value })}
                />
              </Row>
              <Row label="Submit button" htmlFor="insp-fsubmit">
                <input
                  id="insp-fsubmit"
                  className={styles.input}
                  value={el.config.submit.label}
                  maxLength={100}
                  onChange={(e) => setConfig({ ...el.config, submit: { ...el.config.submit, label: e.target.value || "Submit" } })}
                />
              </Row>
              <Row label="Message after submitting" htmlFor="insp-fmsg">
                <input
                  id="insp-fmsg"
                  className={styles.input}
                  value={el.config.submit.message}
                  maxLength={1000}
                  onChange={(e) => setConfig({ ...el.config, submit: { ...el.config.submit, message: e.target.value } })}
                />
              </Row>
            </>
          );
        })()
      ) : null}

      {el.type === "button" ? (
        (() => {
          const a = el.config.actions[0];
          const others = pages.filter((p) => p.id !== currentPageId);
          return (
            <>
              <Row label="Label" htmlFor="insp-blabel">
                <input
                  id="insp-blabel"
                  className={styles.input}
                  value={el.config.label}
                  maxLength={100}
                  onChange={(e) => setConfig({ ...el.config, label: e.target.value || "Button" })}
                />
              </Row>
              <Row label="Style" htmlFor="insp-bstyle">
                <select
                  id="insp-bstyle"
                  className={styles.input}
                  value={el.config.style}
                  onChange={(e) => setConfig({ ...el.config, style: e.target.value })}
                >
                  <option value="primary">Primary</option>
                  <option value="secondary">Secondary</option>
                  <option value="danger">Danger</option>
                  <option value="link">Link</option>
                </select>
              </Row>
              <Row label="When clicked" htmlFor="insp-baction">
                <select
                  id="insp-baction"
                  className={styles.input}
                  value={a?.kind ?? "open_url"}
                  onChange={(e) => {
                    if (e.target.value === "navigate" && others[0]) {
                      setConfig({ ...el.config, actions: [{ kind: "navigate", pageId: others[0].id }] });
                    } else {
                      const safe = SAFE_URL.test(url) ? url : "https://example.com";
                      setUrl(safe);
                      setConfig({ ...el.config, actions: [{ kind: "open_url", urlTemplate: safe, newTab: true }] });
                    }
                  }}
                >
                  <option value="open_url">Open a link</option>
                  <option value="navigate" disabled={others.length === 0}>
                    Go to another page
                  </option>
                </select>
              </Row>
              {a?.kind === "navigate" ? (
                <Row label="Page" htmlFor="insp-bpage">
                  <select
                    id="insp-bpage"
                    className={styles.input}
                    value={a.pageId}
                    onChange={(e) => setConfig({ ...el.config, actions: [{ kind: "navigate", pageId: e.target.value }] })}
                  >
                    {others.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Row>
              ) : (
                <Row label="Link" htmlFor="insp-burl">
                  <input
                    id="insp-burl"
                    className={styles.input}
                    value={url}
                    aria-invalid={!SAFE_URL.test(url)}
                    onChange={(e) => {
                      setUrl(e.target.value);
                      if (SAFE_URL.test(e.target.value)) {
                        setConfig({ ...el.config, actions: [{ kind: "open_url", urlTemplate: e.target.value, newTab: true }] });
                      }
                    }}
                  />
                  {!SAFE_URL.test(url) ? <p className={styles.inspError}>Links must start with https:, mailto: or tel:</p> : null}
                </Row>
              )}
            </>
          );
        })()
      ) : null}

      <button type="button" className={styles.dangerLink} onClick={onRemove}>
        Remove element
      </button>
    </div>
  );
}
