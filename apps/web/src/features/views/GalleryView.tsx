import { useEffect } from "react";
import { RecordCard, cardFields, coverUrl } from "./RecordCard.tsx";
import { useRecordWrites, useViewRecords, type ViewComponentProps } from "./view-hooks.ts";
import { RecordsStatus, statusProps } from "./RecordsStatus.tsx";
import styles from "./views.module.css";

export function GalleryView(props: ViewComponentProps) {
  const { baseId, table, view, config, canEdit, search, onOpenRecord, onCount } = props;
  const g = config.gallery ?? {};
  const cover = g.coverFieldId ?? null;
  const recordsQuery = useViewRecords(baseId, table, view?.id, config, search);
  const { records, queryKey, isLoading } = recordsQuery;
  const writes = useRecordWrites(baseId, table.id, queryKey);
  useEffect(() => onCount?.(records.length), [records.length, onCount]);
  const fields = cardFields(table, config, [cover]);

  async function add() {
    const rec = await writes.create({});
    if (rec) onOpenRecord(rec.id);
  }

  return (
    <div className={styles.galleryWrap}>
      {writes.error ? <div className={styles.toastError}>{writes.error}</div> : null}
      <RecordsStatus {...statusProps(recordsQuery)} />
      <div className={styles.gallery}>
        {records.map((r) => (
          <RecordCard
            key={r.id}
            table={table}
            config={config}
            record={r}
            fields={fields}
            cover={cover ? coverUrl(r, cover) : null}
            coverFit={g.coverFit ?? "cover"}
            coverHeight={180}
            onOpen={() => onOpenRecord(r.id)}
            maxFields={8}
          />
        ))}
        {canEdit ? (
          <button type="button" className={styles.galleryAdd} onClick={() => void add()}>
            <span aria-hidden>+</span>
            Add a record
          </button>
        ) : null}
      </div>
      {!isLoading && records.length === 0 && !canEdit ? (
        <p className={styles.muted}>No records match this view.</p>
      ) : null}
    </div>
  );
}
