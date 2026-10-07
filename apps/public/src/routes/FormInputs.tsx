import { useRef, useState } from "react";
import { optionColor, parseDuration } from "@tabula/field-ui";
import { fileUrl, uploadFormFile, type PublicField, type UploadedFile } from "../lib/public-api.ts";
import styles from "./form.module.css";

export interface PendingUpload {
  key: string;
  name: string;
  progress: number;
  error: string | null;
}

export type FormValue = string | boolean | number | string[] | UploadedFile[] | undefined;

interface InputProps {
  field: PublicField;
  id: string;
  value: FormValue;
  invalid: boolean;
  onChange: (value: FormValue) => void;
}

interface Option {
  id: string;
  label: string;
  color?: string;
}

function optionsOf(field: PublicField): Option[] {
  const raw = field.config["options"];
  return Array.isArray(raw) ? (raw as Option[]).filter((o) => o && typeof o.id === "string") : [];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function isEmptyFormValue(v: FormValue): boolean {
  return v === undefined || v === false || v === "" || (Array.isArray(v) && v.length === 0);
}

/** Client-side check mirroring the server's form coercion. Returns an error message or null. */
export function validateFormValue(field: PublicField, v: FormValue): string | null {
  if (isEmptyFormValue(v)) return null;
  const s = typeof v === "string" ? v.trim() : "";
  switch (field.type) {
    case "email":
      return EMAIL_RE.test(s) ? null : "Enter a valid email address";
    case "url":
      return /^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) || /^[\w-]+(\.[\w-]+)+\S*$/.test(s) ? null : "Enter a valid URL";
    case "number":
    case "currency":
    case "percent":
      return Number.isFinite(Number(s.replace(/[,\s$%]/g, ""))) ? null : "Enter a number";
    case "duration":
      return parseDuration(s) === null ? "Use h:mm, e.g. 1:30" : null;
    default:
      return null;
  }
}

/** Converts a form value to the submit wire shape (CONTRACTS §3 input shapes). */
export function toSubmitValue(field: PublicField, v: FormValue): unknown {
  if (isEmptyFormValue(v)) return undefined;
  switch (field.type) {
    case "number":
    case "currency":
      return Number(String(v).replace(/[,\s$]/g, ""));
    case "percent":
      return Number(String(v).replace(/[,\s%]/g, "")) / 100;
    case "duration":
      return parseDuration(String(v)) ?? undefined;
    case "datetime": {
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
    }
    case "attachment":
      return (v as UploadedFile[]).map((f) => f.id);
    default:
      return v;
  }
}

function Stars({ field, id, value, onChange }: { field: PublicField; id: string; value: FormValue; onChange: (v: FormValue) => void }) {
  const max = Math.min(10, Math.max(1, Number(field.config["max"] ?? 5) || 5));
  const current = typeof value === "number" ? value : 0;
  const [hover, setHover] = useState(0);
  const icon = field.config["icon"] === "heart" ? "♥" : field.config["icon"] === "check" ? "✓" : "★";
  return (
    <div className={styles.rating} role="radiogroup" aria-labelledby={`${id}-label`} onMouseLeave={() => setHover(0)}>
      {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={current === n}
          aria-label={`${n} of ${max}`}
          className={(hover || current) >= n ? styles.ratingOn : styles.ratingOff}
          onMouseEnter={() => setHover(n)}
          onClick={() => onChange(current === n ? undefined : n)}
        >
          {icon}
        </button>
      ))}
    </div>
  );
}

function Attachments({ token, value, onChange, id }: { token: string; value: FormValue; onChange: (v: FormValue) => void; id: string }) {
  const files = (Array.isArray(value) ? value : []) as UploadedFile[];
  const [pending, setPending] = useState<PendingUpload[]>([]);
  const [drag, setDrag] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const latest = useRef(files);
  latest.current = files;

  async function add(list: FileList | null) {
    if (!list) return;
    for (const file of Array.from(list)) {
      const key = `${file.name}-${file.size}-${Math.random().toString(36).slice(2)}`;
      setPending((p) => [...p, { key, name: file.name, progress: 0, error: null }]);
      try {
        const uploaded = await uploadFormFile(token, file, (progress) =>
          setPending((p) => p.map((x) => (x.key === key ? { ...x, progress } : x))),
        );
        latest.current = [...latest.current, uploaded];
        onChange(latest.current);
        setPending((p) => p.filter((x) => x.key !== key));
      } catch (err) {
        setPending((p) =>
          p.map((x) => (x.key === key ? { ...x, error: err instanceof Error ? err.message : "Upload failed" } : x)),
        );
      }
    }
  }

  return (
    <div>
      <div
        className={drag ? styles.dropzoneActive : styles.dropzone}
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDrag(false);
          void add(e.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          id={id}
          type="file"
          multiple
          className={styles.hiddenFile}
          onChange={(e) => {
            void add(e.target.files);
            e.target.value = "";
          }}
        />
        <button type="button" className={styles.uploadBtn} onClick={() => inputRef.current?.click()}>
          Upload files
        </button>
        <span className={styles.dropHint}>or drag and drop here</span>
      </div>
      {files.length || pending.length ? (
        <ul className={styles.fileList}>
          {files.map((f) => (
            <li key={f.id} className={styles.fileItem}>
              {f.thumbnailUrl ? (
                <img src={fileUrl(f.thumbnailUrl)} alt="" className={styles.fileThumb} />
              ) : (
                <span className={styles.fileThumbBlank} aria-hidden>
                  {(f.filename.split(".").pop() ?? "").slice(0, 4).toUpperCase()}
                </span>
              )}
              <span className={styles.fileName}>{f.filename}</span>
              <button
                type="button"
                className={styles.fileRemove}
                aria-label={`Remove ${f.filename}`}
                onClick={() => onChange(files.filter((x) => x.id !== f.id))}
              >
                ✕
              </button>
            </li>
          ))}
          {pending.map((p) => (
            <li key={p.key} className={styles.fileItem}>
              <span className={styles.fileThumbBlank} aria-hidden>
                …
              </span>
              <span className={styles.fileName}>
                {p.name}
                {p.error ? (
                  <span className={styles.fileError}>{p.error}</span>
                ) : (
                  <span className={styles.progress}>
                    <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
                  </span>
                )}
              </span>
              {p.error ? (
                <button
                  type="button"
                  className={styles.fileRemove}
                  aria-label="Dismiss"
                  onClick={() => setPending((list) => list.filter((x) => x.key !== p.key))}
                >
                  ✕
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function FormInput({ token, ...props }: InputProps & { token: string }) {
  const { field, id, value, invalid, onChange } = props;
  const cls = invalid ? `${styles.input} ${styles.inputInvalid}` : styles.input;
  const text = typeof value === "string" ? value : "";

  switch (field.type) {
    case "long_text":
      return <textarea id={id} className={`${cls} ${styles.textarea}`} value={text} onChange={(e) => onChange(e.target.value)} rows={4} />;
    case "checkbox":
      return (
        <label className={styles.checkRow}>
          <input id={id} type="checkbox" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>{value === true ? "Checked" : "Not checked"}</span>
        </label>
      );
    case "number":
    case "currency":
    case "percent": {
      const prefix = field.type === "currency" ? String(field.config["symbol"] ?? "$") : null;
      const suffix = field.type === "percent" ? "%" : null;
      return (
        <div className={invalid ? `${styles.affix} ${styles.inputInvalid}` : styles.affix}>
          {prefix ? <span className={styles.affixText}>{prefix}</span> : null}
          <input id={id} inputMode="decimal" value={text} onChange={(e) => onChange(e.target.value)} />
          {suffix ? <span className={styles.affixText}>{suffix}</span> : null}
        </div>
      );
    }
    case "duration":
      return <input id={id} className={cls} placeholder={String(field.config["format"] ?? "h:mm")} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "rating":
      return <Stars field={field} id={id} value={value} onChange={onChange} />;
    case "date":
      return <input id={id} type="date" className={`${cls} ${styles.dateInput}`} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "datetime":
      return <input id={id} type="datetime-local" className={`${cls} ${styles.dateInput}`} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "single_select": {
      const opts = optionsOf(field);
      if (opts.length > 6) {
        return (
          <select id={id} className={cls} value={text} onChange={(e) => onChange(e.target.value || undefined)}>
            <option value="">Select an option</option>
            {opts.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        );
      }
      return (
        <div className={styles.choices} role="radiogroup" id={id} aria-labelledby={`${id}-label`}>
          {opts.map((o) => {
            const c = optionColor(o.color);
            const on = value === o.id;
            return (
              <button
                key={o.id}
                type="button"
                role="radio"
                aria-checked={on}
                className={on ? styles.choiceOn : styles.choice}
                onClick={() => onChange(on ? undefined : o.id)}
              >
                <span className={styles.choiceDot} style={{ background: c.bg, borderColor: c.fg }} />
                {o.label}
              </button>
            );
          })}
          {opts.length === 0 ? <span className={styles.muted}>No options configured</span> : null}
        </div>
      );
    }
    case "multi_select": {
      const opts = optionsOf(field);
      const sel = Array.isArray(value) ? (value as string[]) : [];
      return (
        <div className={styles.choices} role="group" id={id} aria-labelledby={`${id}-label`}>
          {opts.map((o) => {
            const c = optionColor(o.color);
            const on = sel.includes(o.id);
            return (
              <button
                key={o.id}
                type="button"
                role="checkbox"
                aria-checked={on}
                className={on ? styles.choiceOn : styles.choice}
                onClick={() => onChange(on ? sel.filter((x) => x !== o.id) : [...sel, o.id])}
              >
                <span className={styles.choiceBox} style={{ background: on ? c.bg : undefined, borderColor: c.fg }}>
                  {on ? "✓" : ""}
                </span>
                {o.label}
              </button>
            );
          })}
        </div>
      );
    }
    case "attachment":
      return <Attachments token={token} value={value} onChange={onChange} id={id} />;
    case "email":
      return <input id={id} type="email" autoComplete="email" className={cls} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "url":
      return <input id={id} type="url" placeholder="https://" className={cls} value={text} onChange={(e) => onChange(e.target.value)} />;
    case "phone":
      return <input id={id} type="tel" autoComplete="tel" className={cls} value={text} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input id={id} className={cls} value={text} onChange={(e) => onChange(e.target.value)} />;
  }
}
