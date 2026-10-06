/**
 * Validation + coercion of public form input into stored cell values
 * (CONTRACTS §3 / B's cell storage formats). Pure, unit-testable.
 */

export interface FormFieldLike {
  type: string;
  name: string;
  config: Record<string, unknown>;
}

export class FormValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormValueError";
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isEmptyInput(value: unknown): boolean {
  return (
    value === undefined ||
    value === null ||
    value === false ||
    (typeof value === "string" && value.trim() === "") ||
    (Array.isArray(value) && value.length === 0)
  );
}

function options(field: FormFieldLike): { id: string; label: string }[] {
  const raw = field.config["options"];
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((o): o is { id: string; label: string } =>
      Boolean(o && typeof o === "object" && typeof (o as { id?: unknown }).id === "string"),
    )
    .map((o) => ({ id: o.id, label: String(o.label ?? "") }));
}

function optionId(field: FormFieldLike, v: unknown): string {
  const opts = options(field);
  const s = String(v);
  const byId = opts.find((o) => o.id === s);
  if (byId) return byId.id;
  const byLabel = opts.find((o) => o.label.toLowerCase() === s.trim().toLowerCase());
  if (byLabel) return byLabel.id;
  throw new FormValueError(`"${s}" is not a valid option`);
}

function toNumber(v: unknown): number {
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s$%]/g, ""));
  if (!Number.isFinite(n)) throw new FormValueError("Must be a number");
  return n;
}

/**
 * Returns the stored value, or `undefined` for "no value".
 * `resolveAttachment` maps an `att_…` id to its raw uuid or throws.
 */
export function coerceFormValue(
  field: FormFieldLike,
  value: unknown,
  resolveAttachment: (id: string) => string,
): unknown {
  if (isEmptyInput(value)) return undefined;
  switch (field.type) {
    case "text":
    case "phone": {
      const s = String(value).trim();
      if (s.length > 10_000) throw new FormValueError("Text is too long");
      return s;
    }
    case "long_text": {
      const s = String(value);
      if (s.length > 100_000) throw new FormValueError("Text is too long");
      return s;
    }
    case "email": {
      const s = String(value).trim();
      if (!EMAIL_RE.test(s)) throw new FormValueError("Enter a valid email address");
      return s;
    }
    case "url": {
      const s = String(value).trim();
      if (!/^[a-z][a-z0-9+.-]*:\/\/\S+$/i.test(s) && !/^[\w-]+(\.[\w-]+)+\S*$/.test(s)) {
        throw new FormValueError("Enter a valid URL");
      }
      return s;
    }
    case "number":
    case "currency":
    case "percent":
    case "duration":
      return toNumber(value);
    case "rating": {
      const n = Math.round(toNumber(value));
      const max = Number(field.config["max"] ?? 5) || 5;
      if (n < 0 || n > max) throw new FormValueError(`Rating must be between 0 and ${max}`);
      return n === 0 ? undefined : n;
    }
    case "checkbox":
      return value === true || value === "true" || value === 1 ? true : undefined;
    case "date": {
      const s = String(value).trim().slice(0, 10);
      if (!DATE_RE.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
        throw new FormValueError("Enter a valid date");
      }
      return s;
    }
    case "datetime": {
      const d = new Date(String(value));
      if (Number.isNaN(d.getTime())) throw new FormValueError("Enter a valid date and time");
      return d.toISOString();
    }
    case "single_select":
      return optionId(field, Array.isArray(value) ? value[0] : value);
    case "multi_select": {
      const list = Array.isArray(value) ? value : [value];
      return [...new Set(list.map((v) => optionId(field, v)))];
    }
    case "attachment": {
      const list = Array.isArray(value) ? value : [value];
      return list.map((item) => {
        const id =
          typeof item === "string"
            ? item
            : item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string"
              ? (item as { id: string }).id
              : "";
        return resolveAttachment(id);
      });
    }
    case "barcode": {
      const text =
        typeof value === "object" && value && "text" in value
          ? String((value as { text: unknown }).text)
          : String(value);
      return { text };
    }
    default:
      throw new FormValueError("This field cannot be filled in a form");
  }
}
