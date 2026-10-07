import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, request, type BaseDetail, type TableDto } from "../../lib/api.ts";
import {
  automationsApi,
  type Automation,
  type AutomationAction,
  type AutomationRun,
  type Trigger,
  type TriggerType,
} from "../../lib/api-areas/automations.ts";
import {
  ACTIONS,
  TRIGGERS,
  actionInfo,
  defaultAction,
  summarizeAction,
  summarizeTrigger,
  triggerInfo,
} from "./catalog.ts";
import { ActionEditor, TriggerEditor } from "./editors.tsx";
import { RunDetail, RunHistory } from "./RunHistory.tsx";
import styles from "./automations.module.css";

type Selection = { kind: "trigger" } | { kind: "action"; id: string } | null;
type SaveState = "idle" | "saving" | "saved" | "error";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Something went wrong";
}

function lastRunText(a: Automation): string {
  if (!a.enabled) return "Off";
  if (a.lastRunStatus === "failed") return "Last run failed";
  if (a.lastRunAt) return `Last run ${new Date(a.lastRunAt).toLocaleString()}`;
  return "On · no runs yet";
}

export function AutomationsPanel({ baseId }: { baseId: string }) {
  const queryClient = useQueryClient();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [find, setFind] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: ["automations", baseId],
    queryFn: () => automationsApi.list(baseId),
  });
  const baseQuery = useQuery({
    queryKey: ["bases", baseId],
    queryFn: () => api.getBase(baseId),
  });
  const tables: TableDto[] = (baseQuery.data as BaseDetail | undefined)?.tables ?? [];

  const createMutation = useMutation({
    mutationFn: (type: TriggerType) =>
      automationsApi.create(baseId, {
        name: `Automation ${(listQuery.data?.automations.length ?? 0) + 1}`,
        trigger: {
          type,
          config: triggerInfo(type)?.needsTable && tables[0] ? { tableId: tables[0].id } : type === "scheduled" ? { schedule: { interval: "daily", time: "09:00" } } : {},
        },
        actions: [],
        enabled: false,
      }),
    onSuccess: (res) => {
      setCreateError(null);
      void queryClient.invalidateQueries({ queryKey: ["automations", baseId] });
      setSelectedId(res.automation.id);
    },
    onError: (err) => setCreateError(errorMessage(err)),
  });

  const all = listQuery.data?.automations ?? [];
  const automations = all.filter((a) => a.name.toLowerCase().includes(find.trim().toLowerCase()));
  const selected = all.find((a) => a.id === selectedId) ?? all[0] ?? null;
  const remaining = listQuery.data?.limits.remaining ?? 150;

  return (
    <div className={styles.shell}>
      <aside className={styles.sidebar}>
        <div className={styles.sidebarHead}>
          <h2 className={styles.sidebarTitle}>Automations</h2>
          <CreateMenu
            disabled={remaining <= 0 || createMutation.isPending || tables.length === 0}
            onPick={(t) => createMutation.mutate(t)}
          />
        </div>
        {createError ? <div className={styles.errorBox}>{createError}</div> : null}
        <input
          className={styles.input}
          value={find}
          onChange={(e) => setFind(e.target.value)}
          placeholder="Find an automation"
          aria-label="Find an automation"
        />
        {listQuery.isLoading ? <p className={styles.muted}>Loading…</p> : null}
        {listQuery.isError ? <div className={styles.errorBox}>Couldn’t load automations. {errorMessage(listQuery.error)}</div> : null}
        <ul className={styles.list}>
          {automations.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className={selected?.id === a.id ? `${styles.listItem} ${styles.listItemActive}` : styles.listItem}
                onClick={() => setSelectedId(a.id)}
              >
                <span className={styles.listIcon} aria-hidden>
                  {triggerInfo(a.trigger?.type)?.icon ?? "⚡"}
                </span>
                <span className={styles.listText}>
                  <span className={styles.listName}>{a.name}</span>
                  <span className={styles.listMeta}>
                    <span className={a.enabled ? styles.badgeOn : styles.badgeOff}>{a.enabled ? "ON" : "OFF"}</span>
                    <span className={a.lastRunStatus === "failed" && a.enabled ? styles.metaFail : undefined}>{lastRunText(a)}</span>
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
        <p className={styles.limitNote}>{remaining} of {listQuery.data?.limits.maxAutomations ?? 150} automations remaining</p>
      </aside>

      {selected ? (
        <AutomationBuilder key={selected.id} baseId={baseId} automation={selected} tables={tables} onDeleted={() => setSelectedId(null)} />
      ) : listQuery.isLoading ? (
        <main className={styles.emptyMain} />
      ) : (
        <main className={styles.emptyMain}>
          <div className={styles.emptyState}>
            <h3 className={styles.emptyTitle}>Automate your workflow</h3>
            <p className={styles.muted}>Pick a trigger to create your first automation.</p>
            <div className={styles.triggerGrid}>
              {TRIGGERS.map((t) => (
                <button
                  key={t.type}
                  type="button"
                  className={styles.triggerChoice}
                  disabled={createMutation.isPending || tables.length === 0}
                  onClick={() => createMutation.mutate(t.type)}
                >
                  <span className={styles.choiceIcon} aria-hidden>
                    {t.icon}
                  </span>
                  <span>
                    <span className={styles.choiceLabel}>{t.label}</span>
                    <span className={styles.choiceDesc}>{t.description}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        </main>
      )}
    </div>
  );
}

function CreateMenu({ disabled, onPick }: { disabled: boolean; onPick: (t: TriggerType) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  return (
    <div className={styles.menuWrap} ref={ref}>
      <button type="button" className={styles.btnPrimarySm} disabled={disabled} onClick={() => setOpen((o) => !o)}>
        + Create
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          <div className={styles.menuLabel}>Choose a trigger</div>
          {TRIGGERS.map((t) => (
            <button
              key={t.type}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(t.type);
              }}
            >
              <span aria-hidden className={styles.menuIcon}>
                {t.icon}
              </span>
              {t.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function AutomationBuilder({
  baseId,
  automation,
  tables,
  onDeleted,
}: {
  baseId: string;
  automation: Automation;
  tables: TableDto[];
  onDeleted: () => void;
}) {
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<Automation>(automation);
  const [selection, setSelection] = useState<Selection>({ kind: "trigger" });
  const [tab, setTab] = useState<"edit" | "runs">("edit");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pending = useRef<Partial<Automation> | null>(null);

  // Pick up server-side values we don't edit locally (webhook URL, run stats).
  useEffect(() => {
    setDraft((d) => ({
      ...d,
      webhookUrl: automation.webhookUrl ?? null,
      lastRunAt: automation.lastRunAt ?? null,
      lastRunStatus: automation.lastRunStatus ?? null,
      nextRunAt: automation.nextRunAt ?? null,
      enabled: pending.current?.enabled ?? automation.enabled,
    }));
  }, [automation]);

  const flush = async () => {
    const body = pending.current;
    if (!body) return;
    pending.current = null;
    setSaveState("saving");
    try {
      await automationsApi.update(baseId, automation.id, body);
      setSaveState("saved");
      setSaveError(null);
      void queryClient.invalidateQueries({ queryKey: ["automations", baseId] });
    } catch (err) {
      setSaveState("error");
      setSaveError(errorMessage(err));
    }
  };

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      void flush();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const change = (patch: Partial<Automation>, immediate = false) => {
    setDraft((d) => ({ ...d, ...patch }));
    pending.current = { ...(pending.current ?? {}), ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), immediate ? 0 : 600);
  };

  const removeMutation = useMutation({
    mutationFn: () => automationsApi.remove(baseId, automation.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["automations", baseId] });
      onDeleted();
    },
  });
  const duplicateMutation = useMutation({
    mutationFn: () => automationsApi.duplicate(baseId, automation.id),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["automations", baseId] }),
  });
  const rotateMutation = useMutation({
    mutationFn: () => automationsApi.rotateWebhook(baseId, automation.id),
    onSuccess: (res) => {
      setDraft((d) => ({ ...d, webhookUrl: res.webhookUrl }));
      void queryClient.invalidateQueries({ queryKey: ["automations", baseId] });
    },
  });

  const actions = draft.actions ?? [];
  const setActions = (list: AutomationAction[]) => change({ actions: list });
  const selectedAction = selection?.kind === "action" ? actions.find((a) => a.id === selection.id) : undefined;
  const selectedIndex = selectedAction ? actions.indexOf(selectedAction) : -1;
  const problems = useMemo(() => validate(draft, tables), [draft, tables]);

  const addAction = (type: AutomationAction["type"]) => {
    const a = defaultAction(type, draft.trigger?.config?.tableId);
    setActions([...actions, a]);
    setSelection({ kind: "action", id: a.id });
  };
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= actions.length) return;
    const next = [...actions];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setActions(next);
  };

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <input
          className={styles.nameInput}
          value={draft.name}
          aria-label="Automation name"
          onChange={(e) => change({ name: e.target.value })}
          onBlur={(e) => {
            if (!e.target.value.trim()) change({ name: "Untitled automation" }, true);
          }}
        />
        <span className={styles.saveState} aria-live="polite">
          {saveState === "saving" ? "Saving…" : saveState === "saved" ? "All changes saved" : saveState === "error" ? "Not saved" : ""}
        </span>
        <div className={styles.headerRight}>
          <div className={styles.tabs} role="tablist">
            <button type="button" role="tab" aria-selected={tab === "edit"} className={tab === "edit" ? styles.tabActive : styles.tab} onClick={() => setTab("edit")}>
              Edit
            </button>
            <button type="button" role="tab" aria-selected={tab === "runs"} className={tab === "runs" ? styles.tabActive : styles.tab} onClick={() => setTab("runs")}>
              Run history
            </button>
          </div>
          <label className={styles.switch} title={problems.length && !draft.enabled ? problems[0] : undefined}>
            <input
              type="checkbox"
              role="switch"
              checked={draft.enabled}
              disabled={!draft.enabled && problems.length > 0}
              onChange={(e) => change({ enabled: e.target.checked }, true)}
            />
            <span className={styles.switchTrack} aria-hidden />
            <span>{draft.enabled ? "On" : "Off"}</span>
          </label>
          <div className={styles.menuWrap}>
            <button type="button" className={styles.iconBtn} aria-label="More actions" onClick={() => setMenuOpen((o) => !o)}>
              ⋯
            </button>
            {menuOpen ? (
              <div className={`${styles.menu} ${styles.menuRight}`} role="menu" onMouseLeave={() => setMenuOpen(false)}>
                <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); duplicateMutation.mutate(); }}>
                  Duplicate automation
                </button>
                <button type="button" role="menuitem" className={styles.danger} onClick={() => { setMenuOpen(false); setConfirmDelete(true); }}>
                  Delete automation
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </header>
      {saveError ? <div className={styles.errorBanner}>Couldn’t save: {saveError}</div> : null}
      {!draft.enabled && problems.length > 0 ? (
        <div className={styles.infoBanner}>Finish setup to turn this automation on: {problems.join(" · ")}</div>
      ) : null}

      {tab === "runs" ? (
        <div className={styles.runsPane}>
          <RunHistory baseId={baseId} automationId={automation.id} />
        </div>
      ) : (
        <div className={styles.workspace}>
          <div className={styles.flow}>
            <div className={styles.flowLabel}>Trigger</div>
            <button
              type="button"
              className={selection?.kind === "trigger" ? `${styles.card} ${styles.cardActive}` : styles.card}
              onClick={() => setSelection({ kind: "trigger" })}
            >
              <span className={styles.cardIcon} aria-hidden>
                {triggerInfo(draft.trigger?.type)?.icon}
              </span>
              <span className={styles.cardText}>
                <span className={styles.cardTitle}>{triggerInfo(draft.trigger?.type)?.label ?? "Choose a trigger"}</span>
                <span className={styles.cardSub}>{summarizeTrigger(draft.trigger, tables)}</span>
              </span>
            </button>
            <div className={styles.connector} aria-hidden />
            <div className={styles.flowLabel}>Actions</div>
            {actions.length === 0 ? <p className={styles.muted}>Add the first action this automation should run.</p> : null}
            {actions.map((a, i) => (
              <div key={a.id} className={styles.cardRow}>
                <button
                  type="button"
                  className={selection?.kind === "action" && selection.id === a.id ? `${styles.card} ${styles.cardActive}` : styles.card}
                  onClick={() => setSelection({ kind: "action", id: a.id })}
                >
                  <span className={styles.cardIcon} aria-hidden>
                    {actionInfo(a.type)?.icon}
                  </span>
                  <span className={styles.cardText}>
                    <span className={styles.cardTitle}>
                      {i + 1}. {a.name || actionInfo(a.type)?.label}
                    </span>
                    <span className={styles.cardSub}>{summarizeAction(a, tables)}</span>
                  </span>
                </button>
                <div className={styles.cardTools}>
                  <button type="button" className={styles.iconBtn} aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}>
                    ↑
                  </button>
                  <button type="button" className={styles.iconBtn} aria-label="Move down" disabled={i === actions.length - 1} onClick={() => move(i, 1)}>
                    ↓
                  </button>
                  <button
                    type="button"
                    className={styles.iconBtn}
                    aria-label="Remove action"
                    onClick={() => {
                      setActions(actions.filter((x) => x.id !== a.id));
                      setSelection({ kind: "trigger" });
                    }}
                  >
                    ×
                  </button>
                </div>
              </div>
            ))}
            <AddActionMenu onPick={addAction} />
          </div>

          <section className={styles.config} aria-label="Configuration">
            {selection?.kind === "trigger" ? (
              <>
                <h3 className={styles.configTitle}>Trigger</h3>
                <label className={styles.field}>
                  <span className={styles.fieldLabel}>Trigger type</span>
                  <select
                    className={styles.select}
                    value={draft.trigger?.type}
                    onChange={(e) => {
                      const type = e.target.value as TriggerType;
                      const info = triggerInfo(type);
                      const tableId = draft.trigger?.config?.tableId ?? tables[0]?.id;
                      const next: Trigger = {
                        type,
                        config: info?.needsTable && tableId ? { tableId } : type === "scheduled" ? { schedule: { interval: "daily", time: "09:00" } } : {},
                      };
                      change({ trigger: next }, true);
                    }}
                  >
                    {TRIGGERS.map((t) => (
                      <option key={t.type} value={t.type}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </label>
                <TriggerEditor
                  baseId={baseId}
                  trigger={draft.trigger}
                  tables={tables}
                  webhookUrl={draft.webhookUrl}
                  onChange={(t) => change({ trigger: t })}
                  onRotateWebhook={() => rotateMutation.mutate()}
                />
                <TestPanel baseId={baseId} automation={draft} tables={tables} beforeTest={flush} />
              </>
            ) : selectedAction ? (
              <>
                <h3 className={styles.configTitle}>
                  Action {selectedIndex + 1}: {actionInfo(selectedAction.type)?.label}
                </h3>
                <ActionEditor
                  baseId={baseId}
                  action={selectedAction}
                  index={selectedIndex}
                  allActions={actions}
                  trigger={draft.trigger}
                  tables={tables}
                  onChange={(next) => setActions(actions.map((x) => (x.id === next.id ? next : x)))}
                />
                <TestPanel baseId={baseId} automation={draft} tables={tables} beforeTest={flush} />
              </>
            ) : (
              <p className={styles.muted}>Select the trigger or an action to configure it.</p>
            )}
          </section>
        </div>
      )}

      {confirmDelete ? (
        <div className={styles.overlay} role="dialog" aria-modal="true" aria-labelledby="del-title">
          <div className={styles.dialog}>
            <h3 id="del-title" className={styles.dialogTitle}>
              Delete “{draft.name}”?
            </h3>
            <p className={styles.muted}>The automation stops running and its run history is removed. This can’t be undone.</p>
            {removeMutation.isError ? <div className={styles.errorBox}>{errorMessage(removeMutation.error)}</div> : null}
            <div className={styles.dialogActions}>
              <button type="button" className={styles.btnSecondary} onClick={() => setConfirmDelete(false)}>
                Cancel
              </button>
              <button type="button" className={styles.btnDanger} disabled={removeMutation.isPending} onClick={() => removeMutation.mutate()}>
                {removeMutation.isPending ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

function AddActionMenu({ onPick }: { onPick: (t: AutomationAction["type"]) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  return (
    <div className={styles.menuWrap} ref={ref}>
      <button type="button" className={styles.addAction} onClick={() => setOpen((o) => !o)}>
        + Add advanced logic or action
      </button>
      {open ? (
        <div className={styles.menu} role="menu">
          {ACTIONS.map((a) => (
            <button
              key={a.type}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onPick(a.type);
              }}
            >
              <span aria-hidden className={styles.menuIcon}>
                {a.icon}
              </span>
              <span>
                <span className={styles.choiceLabel}>{a.label}</span>
                <span className={styles.choiceDesc}>{a.description}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** Problems that keep an automation from being turned on. */
function validate(a: Automation, tables: TableDto[]): string[] {
  const out: string[] = [];
  const info = triggerInfo(a.trigger?.type);
  if (!info) out.push("choose a trigger");
  if (info?.needsTable && !tables.some((t) => t.id === a.trigger?.config?.tableId)) out.push("choose the trigger table");
  if (a.trigger?.type === "record.matches_conditions") {
    const f = a.trigger.config?.filter;
    const empty = !f || (f.kind !== "condition" && f.children.length === 0);
    if (empty) out.push("add at least one condition");
  }
  if (a.trigger?.type === "record.enters_view" && !a.trigger.config?.viewId) out.push("choose a view");
  if ((a.actions ?? []).length === 0) out.push("add an action");
  return out;
}

interface RecordRow {
  id: string;
  fields: Record<string, unknown>;
}

function TestPanel({
  baseId,
  automation,
  tables,
  beforeTest,
}: {
  baseId: string;
  automation: Automation;
  tables: TableDto[];
  beforeTest: () => Promise<void>;
}) {
  const info = triggerInfo(automation.trigger?.type);
  const table = tables.find((t) => t.id === automation.trigger?.config?.tableId);
  const [recordId, setRecordId] = useState("");
  const [search, setSearch] = useState("");
  const [body, setBody] = useState('{\n  "example": "value"\n}');
  const [result, setResult] = useState<AutomationRun | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recordsQuery = useQuery({
    queryKey: ["records", baseId, table?.id ?? "", "automation-test", search],
    enabled: Boolean(info?.needsTable && table),
    queryFn: () =>
      request<{ records: RecordRow[] }>(`/v1/bases/${baseId}/tables/${table!.id}/records/query`, {
        method: "POST",
        json: { pageSize: 50, ...(search.trim() ? { search: search.trim() } : {}) },
      }),
  });
  const primary = table?.fields.find((f) => f.id === table.primaryFieldId) ?? table?.fields[0];

  const testMutation = useMutation({
    mutationFn: async () => {
      await beforeTest();
      let parsed: unknown = undefined;
      if (automation.trigger?.type === "webhook.received") {
        try {
          parsed = JSON.parse(body);
        } catch {
          throw new Error("The sample body is not valid JSON");
        }
      }
      return automationsApi.test(baseId, automation.id, {
        ...(recordId ? { recordId } : {}),
        ...(parsed !== undefined ? { body: parsed } : {}),
      });
    },
    onSuccess: (res) => {
      setResult(res.run);
      setError(null);
    },
    onError: (err) => {
      setResult(null);
      setError(errorMessage(err));
    },
  });

  const records = recordsQuery.data?.records ?? [];
  return (
    <div className={styles.testPanel}>
      <h4 className={styles.testTitle}>Test automation</h4>
      <p className={styles.muted}>Runs every action now, even while the automation is off. Changes are real.</p>
      {info?.needsTable ? (
        table ? (
          <>
            <input className={styles.input} placeholder="Search records" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search records" />
            <select className={styles.select} value={recordId} onChange={(e) => setRecordId(e.target.value)} aria-label="Record to test with">
              <option value="">{recordsQuery.isLoading ? "Loading records…" : records.length ? "Choose a record" : "No records found"}</option>
              {records.map((r) => {
                const v = primary ? r.fields[primary.id] : undefined;
                const label = typeof v === "string" || typeof v === "number" ? String(v) : "Unnamed record";
                return (
                  <option key={r.id} value={r.id}>
                    {label}
                  </option>
                );
              })}
            </select>
          </>
        ) : (
          <p className={styles.muted}>Choose the trigger table first.</p>
        )
      ) : null}
      {automation.trigger?.type === "webhook.received" ? (
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Sample JSON body</span>
          <textarea className={styles.textarea} rows={4} value={body} onChange={(e) => setBody(e.target.value)} />
        </label>
      ) : null}
      <button
        type="button"
        className={styles.btnPrimary}
        disabled={testMutation.isPending || (Boolean(info?.needsTable) && !recordId) || (automation.actions ?? []).length === 0}
        onClick={() => testMutation.mutate()}
      >
        {testMutation.isPending ? "Running test…" : "Run test"}
      </button>
      {error ? <div className={styles.errorBox}>{error}</div> : null}
      {result ? <RunDetail run={result} /> : null}
    </div>
  );
}
