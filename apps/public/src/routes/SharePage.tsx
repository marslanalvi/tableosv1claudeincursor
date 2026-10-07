import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { fetchShare, ShareApiError, unlockShare, type PublicSharePayload } from "../lib/public-api.ts";
import shell from "../app/shell.module.css";
import { SharedView } from "./SharedView.tsx";
import { PublicForm } from "./PublicForm.tsx";

function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className={shell.topbar}>
      <span className={shell.brand}>
        <span className={shell.brandMark} aria-hidden>
          T
        </span>
        Tabula
      </span>
      {children}
      <span className={shell.spacer} />
      <span className={shell.powered}>Read-only shared link</span>
    </header>
  );
}

function StateIcon({ kind }: { kind: "lock" | "broken" | "clock" }) {
  const path =
    kind === "lock"
      ? "M7 11V8a5 5 0 0 1 10 0v3M6 11h12v9H6z"
      : kind === "clock"
        ? "M12 7v5l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18Z"
        : "M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1";
  return (
    <div className={shell.stateIcon} aria-hidden>
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
        <path d={path} />
      </svg>
    </div>
  );
}

function ErrorState({ error }: { error: unknown }) {
  const e = error instanceof ShareApiError ? error : null;
  let title = "Something went wrong";
  let text = "We couldn’t load this shared link. Please try again in a moment.";
  let icon: "broken" | "clock" = "broken";
  if (e?.status === 404) {
    title = "Link not found";
    text = "This shared link doesn’t exist. Check that you copied the whole URL.";
  } else if (e?.status === 410) {
    if (e.reason === "expired") {
      icon = "clock";
      title = "This link has expired";
      text = "Ask the person who shared it with you for a new link.";
    } else if (e.reason === "revoked") {
      title = "This link has been disabled";
      text = "The owner turned off sharing for this link.";
    } else {
      title = "This content is no longer available";
      text = "The shared view or form was deleted.";
    }
  } else if (e?.status === 429) {
    title = "Too many requests";
    text = e.message;
  }
  return (
    <div className={shell.center}>
      <div className={shell.stateCard}>
        <StateIcon kind={icon} />
        <h1 className={shell.stateTitle}>{title}</h1>
        <p className={shell.stateText}>{text}</p>
      </div>
    </div>
  );
}

function PasswordGate({ token, onUnlocked }: { token: string; onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className={shell.center}>
      <div className={shell.stateCard}>
        <StateIcon kind="lock" />
        <h1 className={shell.stateTitle}>This link is password protected</h1>
        <p className={shell.stateText}>Enter the password you were given to continue.</p>
        <form
          className={shell.unlockForm}
          onSubmit={async (e) => {
            e.preventDefault();
            if (!password) return;
            setBusy(true);
            setError(null);
            try {
              await unlockShare(token, password);
              onUnlocked();
            } catch (err) {
              setError(
                err instanceof ShareApiError && err.status === 401
                  ? "That password is incorrect."
                  : err instanceof Error
                    ? err.message
                    : "Could not unlock this link.",
              );
            } finally {
              setBusy(false);
            }
          }}
        >
          <input
            className={shell.input}
            type="password"
            autoFocus
            autoComplete="current-password"
            placeholder="Password"
            aria-label="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          {error ? <p className={shell.errorText}>{error}</p> : null}
          <button type="submit" className={shell.primaryBtn} disabled={busy || !password}>
            {busy ? "Checking…" : "Continue"}
          </button>
        </form>
      </div>
    </div>
  );
}

function Crumbs({ share }: { share: PublicSharePayload }) {
  return (
    <nav className={shell.crumbs} aria-label="Shared content">
      <span className={shell.sep}>/</span>
      <strong>{share.base.name}</strong>
      {share.kind !== "base" && share.table ? (
        <>
          <span className={shell.sep}>/</span>
          <span>{share.table.name}</span>
        </>
      ) : null}
      {share.kind === "view" ? <span className={shell.chip}>{share.view.name}</span> : null}
    </nav>
  );
}

export function SharePage({ token }: { token: string }) {
  const qc = useQueryClient();
  const shareQuery = useQuery({
    queryKey: ["public-share", token],
    queryFn: () => fetchShare(token),
    retry: (count, err) => !(err instanceof ShareApiError && err.status < 500) && count < 2,
    refetchOnWindowFocus: false,
  });

  const data = shareQuery.data;
  useEffect(() => {
    if (data) document.title = `${data.title} · Tabula`;
  }, [data]);

  const err = shareQuery.error;
  const needsPassword = err instanceof ShareApiError && err.status === 401;

  if (data?.kind === "form") {
    return <PublicForm token={token} share={data} />;
  }

  return (
    <div className={shell.shell}>
      <TopBar>{data ? <Crumbs share={data} /> : null}</TopBar>
      <main className={shell.main}>
        {shareQuery.isLoading ? (
          <div className={shell.center}>
            <div className={shell.spinner} aria-label="Loading" />
          </div>
        ) : needsPassword ? (
          <PasswordGate token={token} onUnlocked={() => void qc.invalidateQueries({ queryKey: ["public-share", token] })} />
        ) : err ? (
          <ErrorState error={err} />
        ) : data ? (
          <SharedView token={token} share={data} />
        ) : null}
      </main>
    </div>
  );
}
