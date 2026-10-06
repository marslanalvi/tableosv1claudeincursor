import type { FieldDto, TableDto } from "../../lib/api.ts";
import type { ViewConfig, ViewRecord } from "../../lib/api-areas/views.ts";
import { CellValueDisplay } from "./field-value.tsx";
import { primaryText, recordColor, visibleFields } from "./view-utils.ts";
import styles from "./views.module.css";

export function coverUrl(record: ViewRecord, coverFieldId: string | null | undefined): string | null {
  if (!coverFieldId) return null;
  const v = record.fields[coverFieldId];
  if (!Array.isArray(v)) return null;
  for (const a of v as { mime?: string; url?: string; thumbnailUrl?: string | null }[]) {
    if (a && (a.mime?.startsWith("image/") ?? true) && (a.thumbnailUrl || a.url)) {
      return a.thumbnailUrl ?? a.url ?? null;
    }
  }
  return null;
}

/** Fields shown on a card: visible non-primary fields minus excluded ids. */
export function cardFields(table: TableDto, config: ViewConfig, exclude: (string | null | undefined)[]): FieldDto[] {
  const ex = new Set(exclude.filter(Boolean) as string[]);
  return visibleFields(table, config).filter((f) => f.id !== table.primaryFieldId && !ex.has(f.id) && f.type !== "button");
}

export function RecordCard({
  table,
  config,
  record,
  fields,
  cover,
  coverFit = "cover",
  coverHeight,
  onOpen,
  draggable,
  onDragStart,
  onDragEnd,
  dragging,
  maxFields = 6,
}: {
  table: TableDto;
  config: ViewConfig;
  record: ViewRecord;
  fields: FieldDto[];
  cover?: string | null;
  coverFit?: "cover" | "contain";
  coverHeight?: number;
  onOpen: () => void;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
  onDragEnd?: () => void;
  dragging?: boolean;
  maxFields?: number;
}) {
  const title = primaryText(table, record) || "Unnamed record";
  const color = recordColor(config, record, table.fields);
  return (
    <div
      role="button"
      tabIndex={0}
      className={`${styles.card} ${dragging ? styles.cardDragging : ""}`}
      data-record-id={record.id}
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen();
        }
      }}
      style={color ? { boxShadow: `inset 4px 0 0 ${color}` } : undefined}
    >
      {cover !== undefined ? (
        <div className={styles.cardCover} style={coverHeight ? { height: coverHeight } : undefined}>
          {cover ? <img src={cover} alt="" style={{ objectFit: coverFit }} draggable={false} /> : null}
        </div>
      ) : null}
      <div className={styles.cardBody}>
        <div className={styles.cardTitle}>{title}</div>
        {fields.slice(0, maxFields).map((f) => {
          const v = record.fields[f.id];
          return (
            <div key={f.id} className={styles.cardField}>
              <div className={styles.cardFieldLabel}>{f.name}</div>
              <div className={styles.cardFieldValue}>
                {v === undefined || v === null || v === "" ? (
                  <span className={styles.emptyValue} />
                ) : (
                  <CellValueDisplay field={f} value={v} />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
