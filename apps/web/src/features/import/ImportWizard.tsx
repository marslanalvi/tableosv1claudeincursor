import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiProblemError, type BaseDetail } from "../../lib/api.ts";
import { fieldsApi } from "../../lib/api-areas/fields.ts";
import { importRows } from "../../lib/api-areas/collab.ts";
import s from "../share/surface.module.css";
import { convertValue, detectType, parseFile, parseDelimited, toSheet, type DetectedType } from "./parse.ts";

type Step = "source" | "map" | "run" | "done";

const NEW_FIELD = "__new__";
const SKIP = "__skip__";
const CHUNK = 200;

const TYPE_LABELS: Record<string, string> = {
  text: "Single line text",
  long_text: "Long text",
  number: "Number",
  currency: "Currency",
  percent: "Percent",
  checkbox: "Checkbox",
  date: "Date",
  datetime: "Date & time",
  email: "Email",
  url: "URL",
  phone: "Phone",
  single_select: "Single select",
  multi_select: "Multiple select",
};

const WRITABLE_TYPES = new Set([
  "text", "long_text", "email", "url", "phone", "number", "currency", "percent", "rating",
  "duration", "checkbox", "date", "datetime", "single_select", "multi_select", "link",
  "collaborator", "barcode",
]);

interface ColumnMap {
  target: string; // field id | NEW_FIELD | SKIP
  newName: string;
  newType: DetectedType;
}

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) return err.problem.detail ?? err.problem.title;
  const msg = err instanceof Error ? err.message : "";
  if (!msg || /failed to fetch|networkerror|load failed/i.test(msg)) {
    return "Could not reach the TableOS API. Check that the server is running and try again.";
  }
  return msg;
}

/**
 * Import wizard (CONTRACTS §10): file → destination + column mapping with
 * preview → batched import with progress → summary with downloadable errors.
 */
export function ImportWizard({
  baseId,
  tableId,
  onClose,
  onDone,
  onImported,
}: {
  baseId: string;
  tableId?: string;
  onClose: () => void;
  onDone?: () => void;
  onImported?: (tableId: string) => void;
}) {
  const qc = useQueryClient();
  const baseQuery = useQuery({ queryKey: ["bases", baseId], queryFn: () => api.getBase(baseId) });
  const tables = (baseQuery.data as BaseDetail | undefined)?.tables ?? [];

  const [step, setStep] = useState<Step>("source");
  const [fileName, setFileName] = useState("");
  const [grid, setGrid] = useState<string[][] | null>(null);
  const [pasted, setPasted] = useState("");
  const [hasHeader, setHasHeader] = useState(true);
  const [dest, setDest] = useState<"existing" | "new">(tableId ? "existing" : "new");
  const [destTableId, setDestTableId] = useState<string>(tableId ?? "");
  const [newTableName, setNewTableName] = useState("");
  const [mapping, setMapping] = useState<ColumnMap[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [parsing, setParsing] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0, imported: 0, failed: 0 });
  const [rowErrors, setRowErrors] = useState<{ row: number; message: string }[]>([]);
  const [resultTableId, setResultTableId] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && step !== "run") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, step]);

  useEffect(() => {
    if (!destTableId && tables[0] && dest === "existing") setDestTableId(tables[0].id);
  }, [tables, destTableId, dest]);

  const sheet = useMemo(() => (grid ? toSheet(grid, hasHeader) : null), [grid, hasHeader]);
  const destTable = tables.find((t) => t.id === destTableId);

  // (Re)build the default mapping whenever the source or destination changes.
  useEffect(() => {
    if (!sheet) return;
    const fields = dest === "existing" ? (destTable?.fields ?? []) : [];
    setMapping(
      sheet.headers.map((header, i) => {
        const sample = sheet.rows.slice(0, 200).map((r) => r[i] ?? "");
        const detected = detectType(sample);
        const match = fields.find(
          (f) => f.name.trim().toLowerCase() === header.trim().toLowerCase() && WRITABLE_TYPES.has(f.type),
        );
        return {
          target: match ? match.id : dest === "existing" ? SKIP : NEW_FIELD,
          newName: header,
          newType: detected,
        };
      }),
    );
  }, [sheet, dest, destTable]);

  async function loadFile(file: File) {
    setError(null);
    setParsing(true);
    try {
      const rows = await parseFile(file);
      if (rows.length === 0) throw new Error("The file is empty.");
      setGrid(rows);
      setFileName(file.name);
      if (!newTableName) setNewTableName(file.name.replace(/\.[^.]+$/, "").slice(0, 100) || "Imported table");
      setStep("map");
    } catch (err) {
      setError(errorText(err));
    } finally {
      setParsing(false);
    }
  }

  function usePasted() {
    const rows = parseDelimited(pasted);
    if (rows.length === 0) {
      setError("Paste some CSV data first.");
      return;
    }
    setGrid(rows);
    setFileName("pasted.csv");
    if (!newTableName) setNewTableName("Imported table");
    setStep("map");
  }

  const mappedCount = mapping.filter((m) => m.target !== SKIP).length;
  const newFieldNames = mapping.filter((m) => m.target === NEW_FIELD).map((m) => m.newName.trim().toLowerCase());
  const duplicateNames =
    new Set(newFieldNames).size !== newFieldNames.length ||
    (dest === "existing" &&
      newFieldNames.some((n) => destTable?.fields.some((f) => f.name.trim().toLowerCase() === n)));
  const canRun =
    Boolean(sheet && sheet.rows.length > 0 && mappedCount > 0) &&
    !duplicateNames &&
    (dest === "new" ? newTableName.trim().length > 0 : Boolean(destTable)) &&
    mapping.every((m) => m.target !== NEW_FIELD || m.newName.trim().length > 0);

  async function run() {
    if (!sheet) return;
    setError(null);
    setStep("run");
    cancelRef.current = false;
    setRowErrors([]);
    setProgress({ done: 0, total: sheet.rows.length, imported: 0, failed: 0 });
    try {
      // 1) Destination table.
      let targetTableId = destTableId;
      let fields = destTable?.fields ?? [];
      const effective = mapping.map((m) => ({ ...m }));
      if (dest === "new") {
        const created = await api.createTable(baseId, newTableName.trim());
        targetTableId = created.table.id;
        const fresh = await api.getBase(baseId);
        const t = fresh.tables.find((x) => x.id === targetTableId);
        fields = t?.fields ?? [];
        // Use the default primary field for the first mapped column; drop other defaults' names.
        const primary = t?.fields.find((f) => f.id === t.primaryFieldId) ?? t?.fields[0];
        const firstNew = effective.findIndex((m) => m.target === NEW_FIELD);
        if (primary && firstNew >= 0) {
          const m = effective[firstNew]!;
          const primaryType = ["text", "long_text", "email", "url", "phone", "number", "date"].includes(m.newType)
            ? m.newType
            : "text";
          try {
            await fieldsApi.update(baseId, targetTableId, primary.id, {
              name: m.newName.trim(),
              ...(primaryType !== primary.type ? { type: primaryType } : {}),
            });
          } catch {
            await fieldsApi.update(baseId, targetTableId, primary.id, { name: m.newName.trim() });
          }
          m.target = primary.id;
          m.newType = primaryType as DetectedType;
        }
      }
      // 2) New fields.
      const typeOf = new Map(fields.map((f) => [f.id, f.type]));
      for (const m of effective) {
        if (m.target !== NEW_FIELD) continue;
        const f = await fieldsApi.create(baseId, targetTableId, {
          name: m.newName.trim(),
          type: m.newType,
          ...(m.newType === "single_select" || m.newType === "multi_select" ? { config: { options: [] } } : {}),
        });
        m.target = f.id;
        typeOf.set(f.id, f.type);
      }
      for (const m of effective) {
        if (m.target !== SKIP && m.target !== NEW_FIELD && !typeOf.has(m.target)) typeOf.set(m.target, m.newType);
      }
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });

      // 3) Rows in chunks.
      let importJobId: string | undefined;
      let imported = 0;
      let failed = 0;
      const errs: { row: number; message: string }[] = [];
      const firstDataRow = hasHeader ? 2 : 1;
      for (let i = 0; i < sheet.rows.length; i += CHUNK) {
        if (cancelRef.current) break;
        const slice = sheet.rows.slice(i, i + CHUNK);
        const rows = slice.map((r) => {
          const out: Record<string, unknown> = {};
          effective.forEach((m, col) => {
            if (m.target === SKIP) return;
            const v = convertValue(typeOf.get(m.target) ?? "text", r[col] ?? "");
            if (v !== undefined) out[m.target] = v;
          });
          return out;
        });
        const res = await importRows(baseId, {
          tableId: targetTableId,
          rows,
          filename: fileName,
          rowOffset: i,
          typecast: true,
          final: i + CHUNK >= sheet.rows.length,
          ...(importJobId ? { importJobId } : { totalRows: sheet.rows.length }),
        });
        importJobId = res.importJobId;
        imported += res.rowsImported;
        failed += res.rowsFailed;
        errs.push(...res.errors.map((e) => ({ row: e.row + firstDataRow - 1, message: e.message })));
        setRowErrors([...errs]);
        setProgress({ done: Math.min(i + CHUNK, sheet.rows.length), total: sheet.rows.length, imported, failed });
      }
      setResultTableId(targetTableId);
      await qc.invalidateQueries({ queryKey: ["bases", baseId] });
      await qc.invalidateQueries({ queryKey: ["records", baseId] });
      onDone?.();
      setStep("done");
    } catch (err) {
      setError(errorText(err));
      setStep("done");
    }
  }

  function downloadErrors() {
    const lines = [["Row", "Error"], ...rowErrors.map((e) => [String(e.row), e.message])]
      .map((r) => r.map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(","))
      .join("\r\n");
    const url = URL.createObjectURL(new Blob([lines], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "import-errors.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const stepIndex = { source: 0, map: 1, run: 2, done: 2 }[step];

  return (
    <div className={s.backdrop} role="presentation" onMouseDown={step === "run" ? undefined : onClose}>
      <div
        className={s.dialogWide}
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={s.header}>
          <div style={{ flex: 1 }}>
            <h2 id="import-title" className={s.title}>
              Import data
            </h2>
            <p className={s.subtitle}>CSV, TSV or Excel (.xlsx). The first worksheet is imported.</p>
          </div>
          {step !== "run" ? (
            <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
              ×
            </button>
          ) : null}
        </div>
        <div className={s.steps} aria-label="Progress">
          {["Choose file", "Map fields", "Import"].map((label, i) => (
            <span key={label} className={i === stepIndex ? s.stepActive : s.step}>
              <span className={s.stepNum}>{i + 1}</span>
              {label}
              {i < 2 ? <span aria-hidden style={{ margin: "0 4px" }}>›</span> : null}
            </span>
          ))}
        </div>

        {step === "source" ? (
          <>
            <div className={s.body}>
              {error ? <p className={s.error}>{error}</p> : null}
              <div
                className={dragging ? s.dropzoneActive : s.dropzone}
                role="button"
                tabIndex={0}
                onClick={() => fileInput.current?.click()}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") fileInput.current?.click();
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  const f = e.dataTransfer.files[0];
                  if (f) void loadFile(f);
                }}
              >
                <div className={s.settingTitle}>{parsing ? "Reading file…" : "Drop a file here, or click to browse"}</div>
                <p className={s.hint} style={{ marginTop: 4 }}>
                  .csv, .tsv, .txt or .xlsx
                </p>
                <input
                  ref={fileInput}
                  type="file"
                  hidden
                  accept=".csv,.tsv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) void loadFile(f);
                    e.target.value = "";
                  }}
                />
              </div>
              <div>
                <label className={s.label} htmlFor="import-paste">
                  Or paste CSV
                </label>
                <textarea
                  id="import-paste"
                  className={s.textarea}
                  value={pasted}
                  rows={5}
                  placeholder={"Name,Email\nAda Lovelace,ada@example.com"}
                  onChange={(e) => setPasted(e.target.value)}
                />
              </div>
            </div>
            <div className={s.footer}>
              <button type="button" className={s.btnSecondary} onClick={onClose}>
                Cancel
              </button>
              <button type="button" className={s.btnPrimary} disabled={!pasted.trim()} onClick={usePasted}>
                Continue
              </button>
            </div>
          </>
        ) : null}

        {step === "map" && sheet ? (
          <>
            <div className={s.body}>
              {error ? <p className={s.error}>{error}</p> : null}
              <div className={s.row} style={{ gap: 12, flexWrap: "wrap" }}>
                <label className={dest === "new" ? s.radioCardActive : s.radioCard} style={{ flex: 1, minWidth: 220 }}>
                  <input type="radio" checked={dest === "new"} onChange={() => setDest("new")} />
                  <span>
                    <span className={s.settingTitle}>Create a new table</span>
                    <input
                      className={s.input}
                      style={{ marginTop: 8 }}
                      value={newTableName}
                      onChange={(e) => setNewTableName(e.target.value)}
                      onFocus={() => setDest("new")}
                      aria-label="New table name"
                    />
                  </span>
                </label>
                <label
                  className={dest === "existing" ? s.radioCardActive : s.radioCard}
                  style={{ flex: 1, minWidth: 220 }}
                >
                  <input
                    type="radio"
                    checked={dest === "existing"}
                    disabled={tables.length === 0}
                    onChange={() => setDest("existing")}
                  />
                  <span style={{ flex: 1 }}>
                    <span className={s.settingTitle}>Append to an existing table</span>
                    <select
                      className={s.select}
                      style={{ marginTop: 8 }}
                      value={destTableId}
                      onChange={(e) => {
                        setDestTableId(e.target.value);
                        setDest("existing");
                      }}
                      aria-label="Destination table"
                    >
                      {tables.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.name}
                        </option>
                      ))}
                    </select>
                  </span>
                </label>
              </div>
              <label className={s.row} style={{ fontSize: 14 }}>
                <input type="checkbox" checked={hasHeader} onChange={(e) => setHasHeader(e.target.checked)} />
                First row contains field names
              </label>
              <p className={s.hint}>
                {fileName} · {sheet.rows.length.toLocaleString()} row{sheet.rows.length === 1 ? "" : "s"} ·{" "}
                {sheet.headers.length} column{sheet.headers.length === 1 ? "" : "s"}
              </p>
              {duplicateNames ? (
                <p className={s.error}>New field names must be unique and must not match existing fields.</p>
              ) : null}
              <div style={{ overflowX: "auto", border: "1px solid var(--tabula-color-border)", borderRadius: 10 }}>
                <table className={s.table}>
                  <thead>
                    <tr>
                      <th style={{ width: "22%" }}>Column</th>
                      <th style={{ width: "40%" }}>Import into</th>
                      <th>Preview</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sheet.headers.map((header, i) => {
                      const m = mapping[i];
                      if (!m) return null;
                      const set = (patch: Partial<ColumnMap>) =>
                        setMapping((old) => old.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                      return (
                        <tr key={`${header}-${i}`}>
                          <td>
                            <strong style={{ fontWeight: 500 }}>{header}</strong>
                          </td>
                          <td>
                            <select
                              className={s.select}
                              value={m.target}
                              onChange={(e) => set({ target: e.target.value })}
                              aria-label={`Destination for ${header}`}
                            >
                              <option value={SKIP}>Don’t import</option>
                              <option value={NEW_FIELD}>+ New field</option>
                              {dest === "existing"
                                ? (destTable?.fields ?? [])
                                    .filter((f) => WRITABLE_TYPES.has(f.type))
                                    .map((f) => (
                                      <option key={f.id} value={f.id}>
                                        {f.name} · {TYPE_LABELS[f.type] ?? f.type}
                                      </option>
                                    ))
                                : null}
                            </select>
                            {m.target === NEW_FIELD ? (
                              <div className={s.row} style={{ marginTop: 6 }}>
                                <input
                                  className={s.input}
                                  value={m.newName}
                                  onChange={(e) => set({ newName: e.target.value })}
                                  aria-label="New field name"
                                />
                                <select
                                  className={s.select}
                                  value={m.newType}
                                  onChange={(e) => set({ newType: e.target.value as DetectedType })}
                                  aria-label="New field type"
                                >
                                  {Object.entries(TYPE_LABELS).map(([k, label]) => (
                                    <option key={k} value={k}>
                                      {label}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            ) : null}
                          </td>
                          <td className={s.muted}>
                            {sheet.rows
                              .slice(0, 3)
                              .map((r) => r[i] ?? "")
                              .filter((v) => v.trim())
                              .map((v) => (v.length > 40 ? `${v.slice(0, 40)}…` : v))
                              .join(" · ") || "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
            <div className={s.footer}>
              <button
                type="button"
                className={s.btnSecondary}
                onClick={() => {
                  setGrid(null);
                  setStep("source");
                }}
              >
                Back
              </button>
              <span className={s.footerSpacer} />
              <span className={s.hint}>{mappedCount} of {sheet.headers.length} columns</span>
              <button type="button" className={s.btnPrimary} disabled={!canRun} onClick={() => void run()}>
                Import {sheet.rows.length.toLocaleString()} record{sheet.rows.length === 1 ? "" : "s"}
              </button>
            </div>
          </>
        ) : null}

        {step === "run" || step === "done" ? (
          <>
            <div className={s.body}>
              {error ? <p className={s.error}>{error}</p> : null}
              <div className={s.cardSoft}>
                <div className={s.settingTitle}>
                  {step === "run"
                    ? `Importing… ${progress.done.toLocaleString()} of ${progress.total.toLocaleString()}`
                    : error
                      ? "Import stopped"
                      : "Import complete"}
                </div>
                <div className={s.progressTrack} aria-hidden>
                  <div
                    className={s.progressBar}
                    style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}
                  />
                </div>
                <p className={s.hint}>
                  {progress.imported.toLocaleString()} imported
                  {progress.failed ? ` · ${progress.failed.toLocaleString()} failed` : ""}
                </p>
              </div>
              {rowErrors.length ? (
                <div>
                  <div className={s.row} style={{ justifyContent: "space-between", marginBottom: 6 }}>
                    <span className={s.settingTitle}>Rows that could not be imported</span>
                    <button type="button" className={s.btnText} onClick={downloadErrors}>
                      Download error report
                    </button>
                  </div>
                  <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid var(--tabula-color-border)", borderRadius: 10 }}>
                    <table className={s.table}>
                      <thead>
                        <tr>
                          <th style={{ width: 80 }}>Row</th>
                          <th>Error</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rowErrors.slice(0, 200).map((e) => (
                          <tr key={`${e.row}-${e.message}`}>
                            <td>{e.row}</td>
                            <td>{e.message}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ) : null}
            </div>
            <div className={s.footer}>
              {step === "run" ? (
                <button type="button" className={s.btnSecondary} onClick={() => (cancelRef.current = true)}>
                  Stop
                </button>
              ) : (
                <button
                  type="button"
                  className={s.btnPrimary}
                  onClick={() => {
                    if (resultTableId) onImported?.(resultTableId);
                    onClose();
                  }}
                >
                  Done
                </button>
              )}
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
