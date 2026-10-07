import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { automationsApi, type AutomationRun, type StepResult } from "../../lib/api-areas/automations.ts";
import { actionInfo, triggerInfo } from "./catalog.ts";
import styles from "./automations.module.css";

function statusClass(s: string): string {
  if (s === "succeeded") return styles.statusOk ?? "";
  if (s === "failed") return styles.statusFail ?? "";
  return styles.statusPending ?? "";
}

function statusLabel(s: string): string {
  return (
    { succeeded: "Succeeded", failed: "Failed", pending: "Pending", running: "Running", skipped: "Skipped" }[s] ?? s
  );
}

function fmtTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString();
}

function duration(run: AutomationRun): string {
  if (!run.startedAt || !run.finishedAt) return "";
  const ms = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function StepList({ steps, depth = 0 }: { steps: StepResult[]; depth?: number }) {
  return (
    <ol className={styles.stepList} style={{ marginLeft: depth * 16 }}>
      {steps.map((s) => (
        <li key={s.actionId + s.startedAt} className={styles.stepItem}>
          <div className={styles.stepHead}>
            <span className={`${styles.statusDot} ${statusClass(s.status)}`} aria-hidden />
            <strong>{s.name || actionInfo(s.type)?.label || s.type}</strong>
            <span className={styles.muted}>{statusLabel(s.status)}</span>
            {s.branch && s.branch !== "none" ? (
              <span className={styles.badge}>{s.branch === "then" ? "Conditions met" : "Conditions not met"}</span>
            ) : null}
          </div>
          {s.error ? <div className={styles.errorText}>{s.error}</div> : null}
          {s.output !== undefined && s.type !== "condition" ? (
            <details className={styles.details}>
              <summary>Output</summary>
              <pre className={styles.pre}>{JSON.stringify(s.output, null, 2)}</pre>
            </details>
          ) : null}
          {s.steps && s.steps.length > 0 ? <StepList steps={s.steps} depth={depth + 1} /> : null}
        </li>
      ))}
    </ol>
  );
}

export function RunDetail({ run }: { run: AutomationRun }) {
  return (
    <div className={styles.runDetail}>
      <div className={styles.runDetailHead}>
        <span className={`${styles.statusPill} ${statusClass(run.status)}`}>{statusLabel(run.status)}</span>
        <span className={styles.muted}>
          {fmtTime(run.createdAt)} {duration(run) ? `· ${duration(run)}` : ""} {run.isTest ? "· Test" : ""}
          {run.attempts > 1 ? ` · ${run.attempts} attempts` : ""}
        </span>
      </div>
      {run.error ? <div className={styles.errorBox}>{run.error}</div> : null}
      <details className={styles.details} open={false}>
        <summary>Trigger: {triggerInfo(run.triggerType)?.label ?? run.triggerType}</summary>
        <pre className={styles.pre}>{JSON.stringify(run.trigger, null, 2)}</pre>
      </details>
      {run.steps.length > 0 ? <StepList steps={run.steps} /> : <p className={styles.muted}>No actions ran.</p>}
    </div>
  );
}

export function RunHistory({ baseId, automationId }: { baseId: string; automationId: string }) {
  const [selected, setSelected] = useState<string | null>(null);
  const q = useQuery({
    queryKey: ["automations", baseId, automationId, "runs"],
    queryFn: () => automationsApi.runs(baseId, automationId, 100),
    refetchInterval: 5000,
  });
  if (q.isLoading) return <p className={styles.muted}>Loading run history…</p>;
  if (q.isError) return <div className={styles.errorBox}>Couldn’t load run history. {(q.error as Error).message}</div>;
  const runs = q.data?.runs ?? [];
  if (runs.length === 0) {
    return (
      <div className={styles.emptyState}>
        <strong>No runs yet</strong>
        <p className={styles.muted}>Runs appear here when the trigger fires or when you test the automation.</p>
      </div>
    );
  }
  const current = runs.find((r) => r.id === selected) ?? null;
  return (
    <div className={styles.runs}>
      <ul className={styles.runList}>
        {runs.map((r) => (
          <li key={r.id}>
            <button
              type="button"
              className={r.id === current?.id ? `${styles.runItem} ${styles.runItemActive}` : styles.runItem}
              onClick={() => setSelected(r.id === selected ? null : r.id)}
            >
              <span className={`${styles.statusDot} ${statusClass(r.status)}`} aria-hidden />
              <span className={styles.runWhen}>{fmtTime(r.createdAt)}</span>
              <span className={styles.muted}>
                {statusLabel(r.status)}
                {r.isTest ? " · Test" : ""}
              </span>
            </button>
            {r.id === current?.id ? <RunDetail run={r} /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
