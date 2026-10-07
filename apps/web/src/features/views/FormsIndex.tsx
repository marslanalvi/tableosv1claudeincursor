import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { api, type TableDto } from "../../lib/api.ts";
import { createFormShare, publicFormUrl, viewConfigOf, viewsApi, type ViewWire } from "../../lib/api-areas/views.ts";
import { toast } from "../../app/toast.tsx";
import { FormView } from "./FormView.tsx";
import { useViewConfig } from "./view-hooks.ts";
import { setViewsInCaches } from "./view-utils.ts";
import styles from "./views.module.css";

type FormEntry = { table: TableDto; view: ViewWire };

/** Base "Forms" tab: every form view across the base's tables, edited in place (architecture 10 §16). */
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
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creatingFor, setCreatingFor] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");

  const tables = base.data?.tables ?? [];
  const forms: FormEntry[] = useMemo(
    () =>
      tables.flatMap((t) =>
        (t.views as ViewWire[]).filter((v) => v.type === "form").map((v) => ({ table: t, view: v })),
      ),
    [tables],
  );
  const shown = forms.filter((f) => {
    const q = query.trim().toLowerCase();
    if (!q) return true;
    const title = viewConfigOf(f.view).form?.title ?? "";
    return [f.view.name, f.table.name, title].some((s) => s.toLowerCase().includes(q));
  });
  const selected = forms.find((f) => f.view.id === selectedId) ?? forms[0] ?? null;

  useEffect(() => {
    if (!creatingFor && tables[0]) setCreatingFor(tables[0].id);
  }, [creatingFor, tables]);

  if (base.isLoading) return <p className={styles.loading}>Loading forms…</p>;
  if (!base.data) return <p className={styles.muted}>Could not load this base.</p>;

  async function createForm(tableId: string) {
    const table = tables.find((t) => t.id === tableId);
    if (!table || busy) return;
    const names = new Set(table.views.map((v) => v.name));
    let name = `${table.name} form`;
    for (let i = 2; names.has(name); i += 1) name = `${table.name} form ${i}`;
    setBusy(true);
    try {
      const res = await viewsApi.create(baseId, tableId, { name, type: "form" });
      setViewsInCaches(qc, baseId, tableId, (list) =>
        list.some((v) => v.id === res.view.id) ? list : [...list, res.view],
      );
      setSelectedId(res.view.id);
      void qc.invalidateQueries({ queryKey: ["bases", baseId] });
      void qc.invalidateQueries({ queryKey: ["views", baseId, tableId] });
      toast.success(`Created “${name}”`);
    } catch (err) {
      toast.error(err, "Could not create form");
    } finally {
      setBusy(false);
    }
  }

  async function removeForm(entry: FormEntry) {
    if (!window.confirm(`Delete the form “${entry.view.name}”? Records it collected stay in ${entry.table.name}.`)) return;
    try {
      await viewsApi.remove(baseId, entry.table.id, entry.view.id);
      setViewsInCaches(qc, baseId, entry.table.id, (list) => list.filter((v) => v.id !== entry.view.id));
      setSelectedId(null);
      void qc.invalidateQueries({ queryKey: ["bases", baseId] });
      toast.success("Form deleted");
    } catch (err) {
      toast.error(err, "Could not delete form");
    }
  }

  return (
    <div className={styles.formsStudio}>
      <aside className={styles.formsList} aria-label="Forms">
        <div className={styles.formsListHead}>
          <h2 className={styles.formsIndexTitle}>Forms</h2>
          <p className={styles.muted}>Collect records into your tables with shareable forms.</p>
        </div>
        <div className={styles.formsCreate}>
          <select
            className={styles.select}
            aria-label="Table for new form"
            value={creatingFor}
            onChange={(e) => setCreatingFor(e.target.value)}
          >
            {tables.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.primaryBtn}
            disabled={!creatingFor || busy}
            onClick={() => void createForm(creatingFor)}
          >
            {busy ? "Creating…" : "+ New form"}
          </button>
        </div>
        {forms.length > 3 ? (
          <input
            className={styles.input}
            placeholder="Find a form"
            aria-label="Find a form"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : null}
        <div className={styles.formsListItems}>
          {shown.map((f) => {
            const cfg = viewConfigOf(f.view).form;
            const active = selected?.view.id === f.view.id;
            return (
              <button
                key={f.view.id}
                type="button"
                className={styles.formsListItem}
                data-active={active}
                aria-current={active ? "true" : undefined}
                onClick={() => setSelectedId(f.view.id)}
              >
                <span className={styles.formsListIcon} aria-hidden>
                  ▤
                </span>
                <span className={styles.formsListText}>
                  <span className={styles.formsListName}>{cfg?.title || f.view.name}</span>
                  <span className={styles.formsListMeta}>
                    {f.table.name} · {cfg?.fields.length ?? 0} question{(cfg?.fields.length ?? 0) === 1 ? "" : "s"}
                  </span>
                </span>
              </button>
            );
          })}
          {forms.length === 0 ? (
            <p className={styles.muted}>No forms yet. Pick a table and create one.</p>
          ) : null}
        </div>
      </aside>

      <section className={styles.formsEditor} aria-label="Form editor">
        {selected ? (
          <FormEditor
            key={selected.view.id}
            baseId={baseId}
            entry={selected}
            {...(onOpenForm ? { onOpenInData: () => onOpenForm(selected.table.id, selected.view.id) } : {})}
            onDelete={() => void removeForm(selected)}
          />
        ) : (
          <div className={styles.emptyState}>
            <h3>No forms yet</h3>
            <p>Create a form for one of your tables to start collecting responses.</p>
            <button
              type="button"
              className={styles.primaryBtn}
              disabled={!creatingFor || busy}
              onClick={() => void createForm(creatingFor)}
            >
              Create your first form
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function FormEditor({
  baseId,
  entry,
  onOpenInData,
  onDelete,
}: {
  baseId: string;
  entry: FormEntry;
  onOpenInData?: () => void;
  onDelete: () => void;
}) {
  const { table, view } = entry;
  const { config, update, canEdit, saveError } = useViewConfig(baseId, table.id, view);
  const [link, setLink] = useState<string | null>(null);

  async function copyLink() {
    try {
      const url = link ?? publicFormUrl(await createFormShare(baseId, view.id));
      setLink(url);
      await navigator.clipboard?.writeText(url).catch(() => undefined);
      toast.success("Form link copied");
    } catch (err) {
      toast.error(err, "Could not create a share link");
    }
  }

  return (
    <div className={styles.formsEditorInner}>
      <header className={styles.formsEditorHead}>
        <div>
          <h3 className={styles.formsEditorTitle}>{config.form?.title || view.name}</h3>
          <p className={styles.muted}>
            Submissions create records in <strong>{table.name}</strong>
            {saveError ? <span className={styles.fieldError}> · {saveError}</span> : null}
          </p>
        </div>
        <div className={styles.formsCardActions}>
          <button type="button" className={styles.secondaryBtn} onClick={() => void copyLink()}>
            Copy public link
          </button>
          {onOpenInData ? (
            <button type="button" className={styles.secondaryBtn} onClick={onOpenInData}>
              Open in Data
            </button>
          ) : null}
          {canEdit ? (
            <button type="button" className={styles.linkBtn} onClick={onDelete}>
              Delete form
            </button>
          ) : null}
        </div>
      </header>
      {link ? (
        <input className={styles.input} readOnly value={link} aria-label="Form link" onFocus={(e) => e.target.select()} />
      ) : null}
      <div className={styles.formsEditorBody}>
        <FormView
          baseId={baseId}
          table={table}
          view={view}
          config={config}
          update={update}
          canEdit={canEdit}
          search=""
          onOpenRecord={() => undefined}
        />
      </div>
    </div>
  );
}
