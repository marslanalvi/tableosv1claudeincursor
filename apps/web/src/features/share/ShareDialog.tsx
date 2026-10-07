import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { ApiProblemError } from "../../lib/api.ts";
import { shareApi, shareLink, type ShareDto, type ShareTargetType } from "../../lib/api-areas/share.ts";
import s from "./surface.module.css";

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) return err.problem.detail ?? err.problem.title;
  return err instanceof Error ? err.message : "Something went wrong";
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultExpiry(): string {
  const d = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  d.setSeconds(0, 0);
  return toLocalInput(d.toISOString());
}

/**
 * Airtable-style share dialog: one shareable link per target (view, form or
 * whole base) with copy, password, expiry, allow-copy, regenerate and disable.
 */
export function ShareDialog({
  baseId,
  viewId,
  viewType,
  viewName,
  onClose,
}: {
  baseId: string;
  tableId?: string;
  viewId?: string;
  viewType?: string;
  viewName?: string;
  onClose: () => void;
}) {
  const isForm = viewType === "form";
  const [tab, setTab] = useState<"view" | "base">(viewId ? "view" : "base");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const target: { targetType: ShareTargetType; targetId: string } | null =
    tab === "base"
      ? { targetType: "base", targetId: baseId }
      : viewId
        ? { targetType: isForm ? "form" : "view", targetId: viewId }
        : null;

  return (
    <div className={s.backdrop} role="presentation" onMouseDown={onClose}>
      <div
        className={s.dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className={s.header}>
          <div style={{ flex: 1 }}>
            <h2 id="share-title" className={s.title}>
              {tab === "base" ? "Share base" : isForm ? "Share form" : "Share view"}
            </h2>
            <p className={s.subtitle}>
              {tab === "base"
                ? "Anyone with the link can view every table in this base (read-only)."
                : isForm
                  ? "Anyone with the link can fill out this form. Submissions become new records."
                  : `Anyone with the link can view ${viewName ? `“${viewName}”` : "this view"} (read-only). Hidden fields stay hidden.`}
            </p>
          </div>
          <button type="button" className={s.close} aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        {viewId ? (
          <div className={s.tabs} role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={tab === "view"}
              className={tab === "view" ? s.tabActive : s.tab}
              onClick={() => setTab("view")}
            >
              {isForm ? "Form link" : "This view"}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={tab === "base"}
              className={tab === "base" ? s.tabActive : s.tab}
              onClick={() => setTab("base")}
            >
              Entire base
            </button>
          </div>
        ) : null}
        {target ? (
          <SharePanel key={`${target.targetType}:${target.targetId}`} baseId={baseId} target={target} />
        ) : (
          <div className={s.body}>
            <p className={s.hint}>Select a view to share it.</p>
          </div>
        )}
      </div>
    </div>
  );
}

function SharePanel({
  baseId,
  target,
}: {
  baseId: string;
  target: { targetType: ShareTargetType; targetId: string };
}) {
  const qc = useQueryClient();
  const queryKey = ["shares", baseId, target.targetId];
  const sharesQuery = useQuery({
    queryKey,
    queryFn: () => shareApi.list(baseId, { targetId: target.targetId }),
  });
  const share: ShareDto | undefined = sharesQuery.data?.shares.find(
    (x) => x.targetType === target.targetType && x.status !== "revoked",
  );
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [expiryOpen, setExpiryOpen] = useState(false);
  const [expiry, setExpiry] = useState("");

  useEffect(() => {
    setExpiry(toLocalInput(share?.expiresAt ?? null));
  }, [share?.expiresAt]);

  const onDone = (res?: { share: ShareDto }) => {
    setError(null);
    if (res?.share) {
      qc.setQueryData(queryKey, (old: { shares: ShareDto[] } | undefined) => ({
        shares: [res.share, ...(old?.shares ?? []).filter((x) => x.id !== res.share.id)],
      }));
    }
    void qc.invalidateQueries({ queryKey });
  };
  const onError = (err: unknown) => setError(errorText(err));

  const create = useMutation({
    mutationFn: () => shareApi.create(baseId, { targetType: target.targetType, targetId: target.targetId }),
    onSuccess: onDone,
    onError,
  });
  const update = useMutation({
    mutationFn: (body: { password?: string | null; expiresAt?: string | null; allowCopy?: boolean }) =>
      shareApi.update(baseId, share!.id, body),
    onSuccess: (res) => {
      onDone(res);
      setPasswordOpen(false);
      setPassword("");
      setExpiryOpen(false);
    },
    onError,
  });
  const regenerate = useMutation({
    mutationFn: () => shareApi.regenerate(baseId, share!.id),
    onSuccess: onDone,
    onError,
  });
  const revoke = useMutation({
    mutationFn: () => shareApi.revoke(baseId, share!.id),
    onSuccess: () => {
      qc.setQueryData(queryKey, { shares: [] });
      onDone();
    },
    onError,
  });

  const busy = create.isPending || update.isPending || regenerate.isPending || revoke.isPending;
  const url = share ? shareLink(share) : "";
  const expired = share?.status === "expired";

  if (sharesQuery.isLoading) {
    return (
      <div className={s.body}>
        <p className={s.hint}>Loading…</p>
      </div>
    );
  }

  if (!share) {
    return (
      <>
        <div className={s.body}>
          {sharesQuery.isError ? <p className={s.error}>{errorText(sharesQuery.error)}</p> : null}
          {error ? <p className={s.error}>{error}</p> : null}
          <div className={s.cardSoft}>
            <div className={s.settingTitle}>
              {target.targetType === "form" ? "Shareable form link" : "Shareable read-only link"}
            </div>
            <p className={s.hint}>
              Create a link that works for people without a Tabula account. You can add a password,
              set an expiration date, or disable the link at any time.
            </p>
          </div>
        </div>
        <div className={s.footer}>
          <button
            type="button"
            className={s.btnPrimary}
            disabled={busy}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create shareable link"}
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <div className={s.body}>
        {error ? <p className={s.error}>{error}</p> : null}
        {expired ? (
          <p className={s.error}>This link expired {new Date(share.expiresAt!).toLocaleString()}. Extend or remove the expiration to re-enable it.</p>
        ) : null}
        <div>
          <label className={s.label} htmlFor="share-url">
            Link
          </label>
          <div className={s.linkBox}>
            <input
              id="share-url"
              className={s.linkInput}
              readOnly
              value={url}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              type="button"
              className={s.btnSecondary}
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(url);
                } catch {
                  const el = document.getElementById("share-url") as HTMLInputElement | null;
                  el?.select();
                  document.execCommand("copy");
                }
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              }}
            >
              {copied ? "Copied" : "Copy link"}
            </button>
            <a className={s.btnText} href={url} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          </div>
        </div>

        <div className={s.card}>
          <div className={s.settingRow}>
            <div className={s.settingText}>
              <div className={s.settingTitle}>Restrict access with a password</div>
              <p className={s.hint}>
                {share.hasPassword ? "Viewers must enter the password." : "Anyone with the link can open it."}
              </p>
              {passwordOpen ? (
                <form
                  className={s.row}
                  style={{ marginTop: 8 }}
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (password.length >= 4) update.mutate({ password });
                  }}
                >
                  <input
                    className={s.input}
                    type="password"
                    autoFocus
                    placeholder="At least 4 characters"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    aria-label="Share password"
                  />
                  <button type="submit" className={`${s.btnPrimary} ${s.btnSmall}`} disabled={password.length < 4 || busy}>
                    Save
                  </button>
                  <button type="button" className={`${s.btnSecondary} ${s.btnSmall}`} onClick={() => setPasswordOpen(false)}>
                    Cancel
                  </button>
                </form>
              ) : share.hasPassword ? (
                <button type="button" className={s.btnText} onClick={() => setPasswordOpen(true)}>
                  Change password
                </button>
              ) : null}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={share.hasPassword || passwordOpen}
              aria-label="Password protection"
              className={share.hasPassword || passwordOpen ? s.switchOn : s.switch}
              disabled={busy}
              onClick={() => {
                if (share.hasPassword) update.mutate({ password: null });
                else setPasswordOpen((v) => !v);
              }}
            />
          </div>

          <div className={s.settingRow}>
            <div className={s.settingText}>
              <div className={s.settingTitle}>Set an expiration date</div>
              <p className={s.hint}>
                {share.expiresAt
                  ? `${expired ? "Expired" : "Expires"} ${new Date(share.expiresAt).toLocaleString()}`
                  : "The link never expires."}
              </p>
              {expiryOpen || share.expiresAt ? (
                <div className={s.row} style={{ marginTop: 8 }}>
                  <input
                    className={s.input}
                    type="datetime-local"
                    value={expiry}
                    min={toLocalInput(new Date().toISOString())}
                    onChange={(e) => setExpiry(e.target.value)}
                    aria-label="Expiration date"
                  />
                  <button
                    type="button"
                    className={`${s.btnPrimary} ${s.btnSmall}`}
                    disabled={!expiry || busy || toLocalInput(share.expiresAt) === expiry}
                    onClick={() => update.mutate({ expiresAt: new Date(expiry).toISOString() })}
                  >
                    Save
                  </button>
                </div>
              ) : null}
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={Boolean(share.expiresAt) || expiryOpen}
              aria-label="Expiration"
              className={share.expiresAt || expiryOpen ? s.switchOn : s.switch}
              disabled={busy}
              onClick={() => {
                if (share.expiresAt) {
                  update.mutate({ expiresAt: null });
                } else {
                  setExpiry(defaultExpiry());
                  setExpiryOpen((v) => !v);
                }
              }}
            />
          </div>

          {target.targetType !== "form" ? (
            <div className={s.settingRow}>
              <div className={s.settingText}>
                <div className={s.settingTitle}>Allow viewers to copy data</div>
                <p className={s.hint}>Shows a CSV download button on the shared page.</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={share.allowCopy}
                aria-label="Allow copying data"
                className={share.allowCopy ? s.switchOn : s.switch}
                disabled={busy}
                onClick={() => update.mutate({ allowCopy: !share.allowCopy })}
              />
            </div>
          ) : null}
        </div>
      </div>
      <div className={s.footer}>
        <button
          type="button"
          className={s.btnDanger}
          disabled={busy}
          onClick={() => {
            if (window.confirm("Disable this link? People using it will no longer have access.")) revoke.mutate();
          }}
        >
          Disable link
        </button>
        <span className={s.footerSpacer} />
        <button
          type="button"
          className={s.btnSecondary}
          disabled={busy}
          onClick={() => {
            if (window.confirm("Generate a new link? The current link will stop working.")) regenerate.mutate();
          }}
        >
          {regenerate.isPending ? "Generating…" : "Generate new link"}
        </button>
      </div>
    </>
  );
}
