import { useEffect, useState } from "react";
import type { FieldDto, TableDto } from "../../lib/api.ts";
import type { ViewConfig, ViewRecord } from "../../lib/api-areas/views.ts";
import { CellValueDisplay } from "./field-value.tsx";
import { useRecordWrites, useViewRecords, type ViewComponentProps } from "./view-hooks.ts";
import { colorOf, groupRecords, primaryText, recordColor, visibleFields, type RecordGroup } from "./view-utils.ts";
import { RecordsStatus, statusProps } from "./RecordsStatus.tsx";
import styles from "./views.module.css";

function ListRow({
  table,
  config,
  record,
  fields,
  expanded,
  onToggle,
  onOpen,
}: {
  table: TableDto;
  config: ViewConfig;
  record: ViewRecord;
  fields: FieldDto[];
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const color = recordColor(config, record, table.fields);
  const inline = fields.slice(0, 4);
  return (
    <div className={styles.listItem} data-record-id={record.id}>
      <div className={styles.listRow} style={color ? { boxShadow: `inset 3px 0 0 ${color}` } : undefined}>
        <button
          type="button"
          className={styles.listChevron}
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse record" : "Expand record"}
          onClick={onToggle}
        >
          <span data-open={expanded ? "true" : "false"}>▸</span>
        </button>
        <button type="button" className={styles.listTitle} onClick={onToggle}>
          {primaryText(table, record) || "Unnamed record"}
        </button>
        <div className={styles.listInline}>
          {inline.map((f) => (
            <span key={f.id} className={styles.listCell} title={f.name}>
              <CellValueDisplay field={f} value={record.fields[f.id]} />
            </span>
          ))}
        </div>
        <button type="button" className={styles.linkBtn} onClick={onOpen}>
          Open
        </button>
      </div>
      {expanded ? (
        <dl className={styles.listDetails}>
          {fields.map((f) => (
            <div key={f.id} className={styles.listDetail}>
              <dt>{f.name}</dt>
              <dd>
                {record.fields[f.id] === undefined ? (
                  <span className={styles.muted}>—</span>
                ) : (
                  <CellValueDisplay field={f} value={record.fields[f.id]} />
                )}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
    </div>
  );
}

export function ListView(props: ViewComponentProps) {
  const { baseId, table, view, config, canEdit, search, onOpenRecord, onCount } = props;
  const recordsQuery = useViewRecords(baseId, table, view?.id, config, search);
  const { records, queryKey, isLoading } = recordsQuery;
  const writes = useRecordWrites(baseId, table.id, queryKey);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set());
  useEffect(() => onCount?.(records.length), [records.length, onCount]);
  const fields = visibleFields(table, config).filter((f) => f.id !== table.primaryFieldId);
  const groups = groupRecords(records, config.groups, table.fields);

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  };

  const renderRows = (rs: ViewRecord[]) =>
    rs.map((r) => (
      <ListRow
        key={r.id}
        table={table}
        config={config}
        record={r}
        fields={fields}
        expanded={expanded.has(r.id)}
        onToggle={() => setExpanded((s) => toggle(s, r.id))}
        onOpen={() => onOpenRecord(r.id)}
      />
    ));

  const renderGroups = (gs: RecordGroup<ViewRecord>[], path: string, depth: number) =>
    gs.map((g) => {
      const id = `${path}/${g.key}`;
      const closed = collapsedGroups.has(id);
      const c = g.color ? colorOf(g.color) : null;
      return (
        <section key={id} className={styles.listGroup} style={{ marginLeft: depth * 16 }}>
          <button
            type="button"
            className={styles.listGroupHead}
            aria-expanded={!closed}
            onClick={() => setCollapsedGroups((s) => toggle(s, id))}
          >
            <span className={styles.listChevronIcon} data-open={closed ? "false" : "true"}>
              ▸
            </span>
            <span className={styles.muted}>{g.field.name}</span>
            <span className={styles.stackChip} style={c ? { background: c.bg, color: c.fg } : undefined}>
              {g.label}
            </span>
            <span className={styles.stackCount}>{g.records.length}</span>
          </button>
          {closed ? null : g.children.length ? renderGroups(g.children, id, depth + 1) : renderRows(g.records)}
        </section>
      );
    });

  async function add() {
    const rec = await writes.create({});
    if (rec) onOpenRecord(rec.id);
  }

  return (
    <div className={styles.listWrap}>
      {writes.error ? <div className={styles.toastError}>{writes.error}</div> : null}
      <RecordsStatus {...statusProps(recordsQuery)} />
      <div className={styles.listActions}>
        <button type="button" className={styles.linkBtn} onClick={() => setExpanded(new Set(records.map((r) => r.id)))}>
          Expand all
        </button>
        <button type="button" className={styles.linkBtn} onClick={() => setExpanded(new Set())}>
          Collapse all
        </button>
      </div>
      <div className={styles.list}>
        {groups.length ? renderGroups(groups, "", 0) : renderRows(records)}
        {!isLoading && records.length === 0 ? <p className={styles.muted}>No records match this view.</p> : null}
      </div>
      {canEdit ? (
        <button type="button" className={styles.addRowBtn} onClick={() => void add()}>
          + Add record
        </button>
      ) : null}
    </div>
  );
}
