import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, ApiProblemError, type TableDto } from "../../lib/api.ts";
import { createFormShare, publicFormUrl, viewConfigOf, viewsApi, type ViewWire } from "../../lib/api-areas/views.ts";
import { FormPreview } from "./FormView.tsx";
import { setViewsInCaches } from "./view-utils.ts";
import styles from "./views.module.css";

/** Base "Forms" tab: every form view across the base's tables (CONTRACTS §10). */
export function FormsIndex({
  baseId,
  onOpenForm,
}: {
  baseId: string;
  /** Optional: jump to the form view in the Data tab. */
  onOpenForm?: (tableId: string, viewId: string) => void;
}) {
  const qc = useQueryClient();
  const base = useQuery({ queryKey: ["bases", baseId], queryFn: () => api.getBase(baseId) });
  const [filling, setFilling] = useState<{ table: TableDto; view: ViewWire } | null>(null);
  const [links, setLinks] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string>("");

  if (base.isLoading) return <p className={styles.loading}>Loading forms…</p>;
  if (!base.data) return <p className={styles.muted}>Could not load this base.</p>;
  const tables = base.data.tables;
  const forms = tables.flatMap((t) =>
    (t.views as ViewWire[]).filter((v) => v.type === "form").map((v) => ({ table: t, view: v })),
  );

  async function share(viewId: string) {
    setError(null);
    try {
      const s = await createFormShare(baseId, viewId);
      setLinks((l) => ({ ...l, [viewId]: publicFormUrl(s) }));
    } catch (err) {
      setError(err instanceof ApiProblemError ? (err.problem.detail ?? err.problem.title) : "Could not create link");
    }
  }

  async function createForm(tableId: string) {
    const table = tables.find((t) => t.id === tableId);
    if (!table) return;
    const names = new Set(table.views.map((v) => v.name));
    let name = `${table.name} form`;
    for (let i = 2; names.has(name); i += 1) name = `${table.name} form ${i}`;
    try {
      const res = await viewsApi.create(baseId, tableId, { name, type: "form" });
      // The Data tab picks its active view from these caches as soon as it mounts.
      setViewsInCaches(qc, baseId, tableId, (list) =>
        list.some((v) => v.id === res.view.id) ? list : [...list, res.view],
      );
      void qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["views", baseId, tableId] });
      onOpenForm?.(tableId, res.view.id);
    } catch (err) {
      setError(err instanceof ApiProblemError ? (err.problem.detail ?? err.problem.title) : "Could not create form");
    }
  }

  return (
    <div className={styles.formsIndex}>
      <div className={styles.formsIndexHead}>
        <div>
          <h2 className={styles.formsIndexTitle}>Forms</h2>
          <p className={styles.muted}>Collect records into your tables with shareable forms.</p>
        </div>
        <div className={styles.formsIndexCreate}>
          <select
            className={styles.select}
            aria-label="Table for new form"
            value={creatingFor}
            onChange={(e) => setCreatingFor(e.target.value)}
          >
            <option value="">Choose a table…</option>
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={!creatingFor}
            onClick={() => void createForm(creatingFor)}
          >
            Create form
          </button>
        </div>
      </div>
      {error ? <div className={styles.fieldError}>{error}</div> : null}
      {forms.length === 0 ? (
        <div className={styles.emptyState}>
          <h3>No forms yet</h3>
          <p>Create a form for one of your tables to start collecting responses.</p>
        </div>
      ) : (
        <div className={styles.formsGrid}>
          {forms.map(({ table, view }) => {
            const cfg = viewConfigOf(view).form;
            return (
              <article key={view.id} className={styles.formsCard}>
                <div className={styles.formsCardBand} aria-hidden>
                  ▤
                </div>
                <div className={styles.formsCardBody}>
                  <h3 className={styles.formsCardTitle}>{cfg?.title || view.name}</h3>
                  <p className={styles.muted}>
                    {view.name} · {table.name} · {cfg?.fields.length ?? 0} field{(cfg?.fields.length ?? 0) === 1 ? "" : "s"}
                  </p>
                  {links[view.id] ? (
                    <input className={styles.input} readOnly value={links[view.id]} aria-label="Form link" onFocus={(e) => e.target.select()} />
                  ) : null}
                  <div className={styles.formsCardActions}>
                    <button type="button" className={styles.secondaryBtn} onClick={() => setFilling({ table, view })}>
                      Fill out
                    </button>
                    <button type="button" className={styles.secondaryBtn} onClick={() => void share(view.id)}>
                      Share link
                    </button>
                    {onOpenForm ? (
                      <button type="button" className={styles.linkBtn} onClick={() => onOpenForm(table.id, view.id)}>
                        Edit form
                      </button>
                    ) : null}
                  </div>
                </div>
              </article>
            );
          })}
        </div>
      )}
      {filling ? (
        <div className={styles.modalBackdrop} role="dialog" aria-label={`Fill out ${filling.view.name}`} onMouseDown={(e) => { if (e.target === e.currentTarget) setFilling(null); }}>
          <div className={styles.modal}>
            <div className={styles.modalHead}>
              <span>{filling.view.name}</span>
              <button type="button" className={styles.iconBtn} aria-label="Close" onClick={() => setFilling(null)}>
                ✕
              </button>
            </div>
            <FormPreview
              baseId={baseId}
              table={filling.table}
              form={
                viewConfigOf(filling.view).form ?? {
                  title: filling.view.name,
                  description: "",
                  fields: [],
                  submitLabel: "Submit",
                  successMessage: "Thank you for submitting the form!",
                  allowResubmit: true,
                }
              }
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
