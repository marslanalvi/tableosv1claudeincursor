import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ApiProblemError, type FieldDto, type TableDto } from "../../lib/api.ts";
import {
  createFormShare,
  publicFormUrl,
  viewRecordsApi,
  type FormFieldConfig,
  type ViewConfig,
} from "../../lib/api-areas/views.ts";
import { ValueEditor } from "./field-value.tsx";
import type { ViewComponentProps } from "./view-hooks.ts";
import { isEditableField } from "./view-utils.ts";
import styles from "./views.module.css";

type FormConfig = NonNullable<ViewConfig["form"]>;

function defaultForm(table: TableDto): FormConfig {
  const editable = table.fields.filter(isEditableField);
  editable.sort((a, b) => Number(b.id === table.primaryFieldId) - Number(a.id === table.primaryFieldId));
  return {
    title: table.name,
    description: "",
    fields: editable.map((f) => ({ fieldId: f.id, required: f.id === table.primaryFieldId })),
    submitLabel: "Submit",
    successMessage: "Thank you for submitting the form!",
    allowResubmit: true,
  };
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);
}

/** The fillable form (used for the live preview and internal submissions). */
export function FormPreview({
  baseId,
  table,
  form,
  interactive = true,
}: {
  baseId: string;
  table: TableDto;
  form: FormConfig;
  interactive?: boolean;
}) {
  const qc = useQueryClient();
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<"idle" | "submitting" | "done">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const items = form.fields
    .map((ff) => ({ ff, field: table.fields.find((f) => f.id === ff.fieldId) }))
    .filter((x): x is { ff: FormFieldConfig; field: FieldDto } => Boolean(x.field));

  async function submit() {
    const errs: Record<string, string> = {};
    for (const { ff, field } of items) {
      if (ff.required && (isBlank(values[field.id]) || (field.type === "checkbox" && values[field.id] !== true))) {
        errs[field.id] = "This field is required";
      }
    }
    setErrors(errs);
    if (Object.keys(errs).length) return;
    const payload: Record<string, unknown> = {};
    for (const { field } of items) {
      const v = values[field.id];
      if (!isBlank(v)) payload[field.id] = v;
    }
    setStatus("submitting");
    setSubmitError(null);
    try {
      await viewRecordsApi.create(baseId, table.id, payload);
      setValues({});
      setStatus("done");
      void qc.invalidateQueries({ queryKey: ["records", baseId, table.id] });
    } catch (err) {
      setStatus("idle");
      setSubmitError(err instanceof ApiProblemError ? (err.problem.detail ?? err.problem.title) : "Could not submit the form");
    }
  }

  if (status === "done") {
    return (
      <div className={styles.formCard}>
        <div className={styles.formSuccess} role="status">
          <div className={styles.formSuccessIcon} aria-hidden>
            ✓
          </div>
          <p>{form.successMessage || "Thank you for submitting the form!"}</p>
          {form.allowResubmit ? (
            <button type="button" className={styles.secondaryBtn} onClick={() => setStatus("idle")}>
              Submit another response
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <form
      className={styles.formCard}
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (interactive) void submit();
      }}
    >
      <h2 className={styles.formTitle}>{form.title || table.name}</h2>
      {form.description ? <p className={styles.formDescription}>{form.description}</p> : null}
      {items.length === 0 ? <p className={styles.muted}>This form has no fields yet.</p> : null}
      {items.map(({ ff, field }) => (
        <div key={field.id} className={styles.formField}>
          <label className={styles.formLabel} htmlFor={`form-${field.id}`}>
            {ff.label?.trim() || field.name}
            {ff.required ? <span className={styles.required}> *</span> : null}
          </label>
          {ff.help ? <div className={styles.formHelp}>{ff.help}</div> : null}
          <ValueEditor
            baseId={baseId}
            id={`form-${field.id}`}
            field={field}
            value={values[field.id]}
            onChange={(v) => {
              setValues((s) => ({ ...s, [field.id]: v }));
              if (errors[field.id]) setErrors((s) => ({ ...s, [field.id]: "" }));
            }}
          />
          {errors[field.id] ? <div className={styles.fieldError}>{errors[field.id]}</div> : null}
        </div>
      ))}
      {submitError ? <div className={styles.fieldError}>{submitError}</div> : null}
      <button type="submit" className={styles.primaryBtn} disabled={!interactive || status === "submitting"}>
        {status === "submitting" ? "Submitting…" : form.submitLabel || "Submit"}
      </button>
    </form>
  );
}

export function FormView(props: ViewComponentProps) {
  const { baseId, table, view, config, update, canEdit } = props;
  const form: FormConfig = config.form ?? defaultForm(table);
  const setForm = (patch: Partial<FormConfig>) => update({ form: { ...form, ...patch } });
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [share, setShare] = useState<{ url: string } | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  const included = new Set(form.fields.map((f) => f.fieldId));
  const available = useMemo(
    () => table.fields.filter((f) => isEditableField(f) && !included.has(f.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [table.fields, form.fields],
  );

  async function getShare(): Promise<string | null> {
    if (share) return share.url;
    if (!view) return null;
    setShareError(null);
    try {
      const s = await createFormShare(baseId, view.id);
      const url = publicFormUrl(s);
      setShare({ url });
      return url;
    } catch (err) {
      setShareError(err instanceof ApiProblemError ? (err.problem.detail ?? err.problem.title) : "Could not create a share link");
      return null;
    }
  }

  function setField(i: number, patch: Partial<FormFieldConfig>) {
    const fields = [...form.fields];
    fields[i] = { ...fields[i]!, ...patch };
    setForm({ fields });
  }

  return (
    <div className={styles.formLayout}>
      {canEdit ? (
        <aside className={styles.formBuilder} aria-label="Form builder">
          <div className={styles.builderSection}>
            <label className={styles.builderLabel} htmlFor="form-title">
              Form title
            </label>
            <input id="form-title" className={styles.input} value={form.title} onChange={(e) => setForm({ title: e.target.value })} />
            <label className={styles.builderLabel} htmlFor="form-desc">
              Description
            </label>
            <textarea
              id="form-desc"
              className={styles.input}
              rows={3}
              value={form.description}
              onChange={(e) => setForm({ description: e.target.value })}
            />
          </div>

          <div className={styles.builderSection}>
            <div className={styles.builderHead}>
              <span className={styles.builderLabel}>Fields on the form</span>
              <span className={styles.muted}>{form.fields.length}</span>
            </div>
            {form.fields.map((ff, i) => {
              const field = table.fields.find((f) => f.id === ff.fieldId);
              if (!field) return null;
              const open = expanded === ff.fieldId;
              return (
                <div
                  key={ff.fieldId}
                  className={`${styles.builderField} ${dragIndex !== null && dragIndex !== i ? styles.builderFieldDroppable : ""}`}
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(i);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", ff.fieldId);
                  }}
                  onDragOver={(e) => {
                    if (dragIndex !== null) e.preventDefault();
                  }}
                  onDrop={(e) => {
                    e.preventDefault();
                    if (dragIndex === null || dragIndex === i) return;
                    const fields = [...form.fields];
                    const [m] = fields.splice(dragIndex, 1);
                    fields.splice(i, 0, m!);
                    setForm({ fields });
                    setDragIndex(null);
                  }}
                  onDragEnd={() => setDragIndex(null)}
                >
                  <div className={styles.builderFieldRow}>
                    <span className={styles.dragHandle} aria-hidden>
                      ⋮⋮
                    </span>
                    <button type="button" className={styles.builderFieldName} onClick={() => setExpanded(open ? null : ff.fieldId)} aria-expanded={open}>
                      {ff.label?.trim() || field.name}
                      {ff.required ? <span className={styles.required}> *</span> : null}
                    </button>
                    <button
                      type="button"
                      className={styles.iconBtn}
                      aria-label={`Remove ${field.name} from form`}
                      onClick={() => setForm({ fields: form.fields.filter((_, j) => j !== i) })}
                    >
                      ✕
                    </button>
                  </div>
                  {open ? (
                    <div className={styles.builderFieldBody}>
                      <label className={styles.builderLabel}>
                        Label
                        <input
                          className={styles.input}
                          placeholder={field.name}
                          value={ff.label ?? ""}
                          onChange={(e) => setField(i, { label: e.target.value })}
                        />
                      </label>
                      <label className={styles.builderLabel}>
                        Help text
                        <textarea
                          className={styles.input}
                          rows={2}
                          value={ff.help ?? ""}
                          onChange={(e) => setField(i, { help: e.target.value })}
                        />
                      </label>
                      <label className={styles.checkLabel}>
                        <input type="checkbox" checked={ff.required} onChange={(e) => setField(i, { required: e.target.checked })} />
                        Required
                      </label>
                    </div>
                  ) : null}
                </div>
              );
            })}
            {available.length ? (
              <>
                <div className={styles.builderHead}>
                  <span className={styles.builderLabel}>Add fields</span>
                  <button
                    type="button"
                    className={styles.linkBtn}
                    onClick={() => setForm({ fields: [...form.fields, ...available.map((f) => ({ fieldId: f.id, required: false }))] })}
                  >
                    Add all
                  </button>
                </div>
                {available.map((f) => (
                  <button
                    key={f.id}
                    type="button"
                    className={styles.builderAdd}
                    onClick={() => setForm({ fields: [...form.fields, { fieldId: f.id, required: false }] })}
                  >
                    + {f.name}
                  </button>
                ))}
              </>
            ) : null}
          </div>

          <div className={styles.builderSection}>
            <label className={styles.builderLabel} htmlFor="form-submit-label">
              Submit button label
            </label>
            <input id="form-submit-label" className={styles.input} value={form.submitLabel} onChange={(e) => setForm({ submitLabel: e.target.value || "Submit" })} />
            <label className={styles.builderLabel} htmlFor="form-success">
              Message after submitting
            </label>
            <textarea id="form-success" className={styles.input} rows={2} value={form.successMessage} onChange={(e) => setForm({ successMessage: e.target.value })} />
            <label className={styles.checkLabel}>
              <input type="checkbox" checked={form.allowResubmit} onChange={(e) => setForm({ allowResubmit: e.target.checked })} />
              Show a "Submit another response" button
            </label>
          </div>
        </aside>
      ) : null}

      <div className={styles.formPreviewPane}>
        <div className={styles.formPreviewBar}>
          <span className={styles.muted}>{canEdit ? "Live preview — submissions create real records" : "Fill out this form"}</span>
          <span className={styles.formPreviewActions}>
            <button type="button" className={styles.secondaryBtn} onClick={() => setPreviewKey((k) => k + 1)}>
              Reset
            </button>
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={async () => {
                const w = window.open("about:blank", "_blank");
                const url = await getShare();
                if (url && w) w.location.href = url;
                else w?.close();
              }}
            >
              Open form
            </button>
            <button type="button" className={styles.primaryBtn} onClick={() => void getShare()}>
              Share form
            </button>
          </span>
        </div>
        {share ? (
          <div className={styles.shareBox}>
            <input className={styles.input} readOnly value={share.url} aria-label="Form link" onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className={styles.secondaryBtn}
              onClick={() => {
                void navigator.clipboard?.writeText(share.url).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
          </div>
        ) : null}
        {shareError ? <div className={styles.fieldError}>{shareError}</div> : null}
        <FormPreview key={previewKey} baseId={baseId} table={table} form={form} />
      </div>
    </div>
  );
}
