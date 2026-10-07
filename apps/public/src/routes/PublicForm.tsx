import { useMemo, useRef, useState } from "react";
import { ShareApiError, submitShareForm, type PublicField, type PublicSharePayload } from "../lib/public-api.ts";
import { FormInput, isEmptyFormValue, toSubmitValue, validateFormValue, type FormValue } from "./FormInputs.tsx";
import styles from "./form.module.css";

type FormShare = Extract<PublicSharePayload, { kind: "form" }>;

interface Item {
  field: PublicField;
  required: boolean;
  label: string;
  help: string;
}

/** `?prefill_<Field name or fld_id>=value`, like Airtable's prefilled form links. */
function prefillFrom(items: Item[]): Record<string, FormValue> {
  const out: Record<string, FormValue> = {};
  const params = new URLSearchParams(window.location.search);
  for (const [key, raw] of params) {
    if (!key.startsWith("prefill_")) continue;
    const name = key.slice("prefill_".length).toLowerCase();
    const item = items.find((i) => i.field.id.toLowerCase() === name || i.field.name.toLowerCase() === name || i.label.toLowerCase() === name);
    if (!item) continue;
    const f = item.field;
    const opts = Array.isArray(f.config["options"]) ? (f.config["options"] as { id: string; label: string }[]) : [];
    const optionId = (s: string) => opts.find((o) => o.id === s || o.label.toLowerCase() === s.trim().toLowerCase())?.id;
    if (f.type === "checkbox") out[f.id] = raw === "true" || raw === "1";
    else if (f.type === "rating") out[f.id] = Number(raw) || undefined;
    else if (f.type === "single_select") out[f.id] = optionId(raw);
    else if (f.type === "multi_select") out[f.id] = raw.split(",").map(optionId).filter((x): x is string => Boolean(x));
    else if (f.type !== "attachment") out[f.id] = raw;
  }
  return out;
}

function CheckCircle() {
  return (
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}

export function PublicForm({ token, share }: { token: string; share: FormShare }) {
  const items: Item[] = useMemo(() => {
    const byId = new Map(share.fields.map((f) => [f.id, f]));
    return share.form.fields
      .map((spec) => {
        const field = byId.get(spec.fieldId);
        return field ? { field, required: spec.required, label: spec.label || field.name, help: spec.help } : null;
      })
      .filter((x): x is Item => x !== null);
  }, [share]);

  const initial = useMemo(() => prefillFrom(items), [items]);
  const [values, setValues] = useState<Record<string, FormValue>>(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ message: string; allowResubmit: boolean } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  function setValue(id: string, v: FormValue) {
    setValues((cur) => ({ ...cur, [id]: v }));
    if (errors[id]) setErrors(({ [id]: _drop, ...rest }) => rest);
  }

  function focusFirstError(errs: Record<string, string>) {
    const first = items.find((i) => errs[i.field.id]);
    if (!first) return;
    const el = formRef.current?.querySelector<HTMLElement>(`[data-field="${first.field.id}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    el?.querySelector<HTMLElement>("input, textarea, select, button")?.focus({ preventScroll: true });
  }

  async function submit() {
    const errs: Record<string, string> = {};
    for (const item of items) {
      const v = values[item.field.id];
      if (item.required && isEmptyFormValue(v)) errs[item.field.id] = "This field is required";
      else {
        const msg = validateFormValue(item.field, v);
        if (msg) errs[item.field.id] = msg;
      }
    }
    setErrors(errs);
    setFormError(null);
    if (Object.keys(errs).length) {
      focusFirstError(errs);
      return;
    }
    const payload: Record<string, unknown> = {};
    for (const item of items) {
      const v = toSubmitValue(item.field, values[item.field.id]);
      if (v !== undefined) payload[item.field.id] = v;
    }
    setBusy(true);
    try {
      const res = await submitShareForm(token, payload);
      setDone({ message: res.successMessage || share.form.successMessage, allowResubmit: res.allowResubmit });
      window.scrollTo({ top: 0 });
    } catch (err) {
      if (err instanceof ShareApiError && err.fieldErrors.length) {
        const map: Record<string, string> = {};
        for (const fe of err.fieldErrors) map[fe.field] = fe.message.replace(/^.*? is required$/, "This field is required");
        setErrors(map);
        focusFirstError(map);
        setFormError(err.message);
      } else {
        setFormError(err instanceof Error ? err.message : "Could not submit the form. Please try again.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={styles.page}>
      <div className={styles.column}>
        <div className={styles.card}>
          <div className={styles.cover} aria-hidden />
          {done ? (
            <div className={styles.success}>
              <div className={styles.successIcon}>
                <CheckCircle />
              </div>
              <h1 className={styles.successTitle}>Thanks for submitting</h1>
              <p className={styles.successText}>{done.message}</p>
              {done.allowResubmit ? (
                <button
                  type="button"
                  className={styles.secondaryBtn}
                  onClick={() => {
                    setValues(initial);
                    setErrors({});
                    setDone(null);
                  }}
                >
                  Submit another response
                </button>
              ) : null}
            </div>
          ) : (
            <form
              ref={formRef}
              className={styles.form}
              noValidate
              onSubmit={(e) => {
                e.preventDefault();
                void submit();
              }}
            >
              <header className={styles.header}>
                <h1 className={styles.title}>{share.form.title || share.title}</h1>
                {share.form.description ? <p className={styles.description}>{share.form.description}</p> : null}
              </header>
              {items.length === 0 ? <p className={styles.muted}>This form has no fields yet.</p> : null}
              {items.map((item) => {
                const id = `f-${item.field.id}`;
                const err = errors[item.field.id];
                return (
                  <div key={item.field.id} className={styles.field} data-field={item.field.id}>
                    <label className={styles.label} htmlFor={id} id={`${id}-label`}>
                      {item.label}
                      {item.required ? (
                        <span className={styles.required} aria-label="required">
                          *
                        </span>
                      ) : null}
                    </label>
                    {item.help ? <p className={styles.help}>{item.help}</p> : null}
                    <FormInput
                      token={token}
                      field={item.field}
                      id={id}
                      value={values[item.field.id]}
                      invalid={Boolean(err)}
                      onChange={(v) => setValue(item.field.id, v)}
                    />
                    {err ? (
                      <p className={styles.fieldError} role="alert">
                        {err}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {formError ? <p className={styles.formError}>{formError}</p> : null}
              <div className={styles.actions}>
                <button type="submit" className={styles.primaryBtn} disabled={busy || items.length === 0}>
                  {busy ? "Submitting…" : share.form.submitLabel || "Submit"}
                </button>
              </div>
            </form>
          )}
        </div>
        <p className={styles.footer}>
          <span className={styles.footerMark}>T</span> Made with TableOS · Never submit passwords through this form.
        </p>
      </div>
    </div>
  );
}
