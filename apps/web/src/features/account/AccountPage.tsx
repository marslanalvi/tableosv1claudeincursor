import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { accountApi, type SessionInfo } from "../../lib/api-areas/account.ts";
import { ApiProblemError } from "../../lib/api.ts";
import { authQueryKey } from "../auth/use-auth.ts";
import { qrSvg } from "./qr.ts";
import styles from "./account.module.css";

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) {
    const p = err.problem as { detail?: string; title?: string; errors?: { message: string }[] };
    return p.errors?.[0]?.message ?? p.detail ?? p.title ?? "Something went wrong";
  }
  return err instanceof Error ? err.message : "Something went wrong";
}

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>{title}</h2>
        {description ? <p className={styles.muted}>{description}</p> : null}
      </div>
      <div className={styles.sectionBody}>{children}</div>
    </section>
  );
}

function Notice({ kind, children }: { kind: "ok" | "error"; children: ReactNode }) {
  return (
    <div role={kind === "error" ? "alert" : "status"} className={kind === "error" ? styles.error : styles.ok}>
      {children}
    </div>
  );
}

function ProfileSection({ name, email }: { name: string; email: string }) {
  const queryClient = useQueryClient();
  const [value, setValue] = useState(name);
  useEffect(() => setValue(name), [name]);
  const save = useMutation({
    mutationFn: () => accountApi.updateProfile(value.trim()),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: authQueryKey }),
  });
  const dirty = value.trim() !== name && value.trim().length > 0;
  return (
    <Section title="Profile" description="Your name is shown to collaborators on records, comments and mentions.">
      <form
        className={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          if (dirty) save.mutate();
        }}
      >
        <label className={styles.label}>
          Name
          <input className={styles.input} value={value} maxLength={200} onChange={(e) => setValue(e.target.value)} />
        </label>
        <label className={styles.label}>
          Email
          <input className={styles.input} value={email} disabled />
        </label>
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={!dirty || save.isPending}>
            {save.isPending ? "Saving…" : "Save"}
          </button>
          {save.isSuccess && !dirty ? <span className={styles.muted}>Saved</span> : null}
        </div>
        {save.isError ? <Notice kind="error">{errorText(save.error)}</Notice> : null}
      </form>
    </Section>
  );
}

function PasswordSection({ hasPassword }: { hasPassword: boolean }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: () => accountApi.changePassword(current, next),
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      void queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
    },
  });
  if (!hasPassword) {
    return (
      <Section title="Password" description="You sign in with Google, so this account has no password.">
        <span />
      </Section>
    );
  }
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (next.length < 12) return setLocalError("Use at least 12 characters.");
    if (next !== confirm) return setLocalError("The new passwords don’t match.");
    setLocalError(null);
    change.mutate();
  };
  return (
    <Section title="Password" description="Changing your password signs you out on every other device.">
      <form className={styles.form} onSubmit={submit}>
        <label className={styles.label}>
          Current password
          <input className={styles.input} type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </label>
        <label className={styles.label}>
          New password
          <input className={styles.input} type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
        </label>
        <label className={styles.label}>
          Confirm new password
          <input className={styles.input} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </label>
        <div className={styles.actions}>
          <button type="submit" className={styles.primary} disabled={!current || !next || change.isPending}>
            {change.isPending ? "Changing…" : "Change password"}
          </button>
        </div>
        {localError ? <Notice kind="error">{localError}</Notice> : null}
        {change.isError ? <Notice kind="error">{errorText(change.error)}</Notice> : null}
        {change.isSuccess ? (
          <Notice kind="ok">
            Password changed.
            {change.data.otherSessionsRevoked > 0
              ? ` Signed out of ${change.data.otherSessionsRevoked} other session${change.data.otherSessionsRevoked === 1 ? "" : "s"}.`
              : ""}
          </Notice>
        ) : null}
      </form>
    </Section>
  );
}

function MfaSection({ enabled, hasPassword }: { enabled: boolean; hasPassword: boolean }) {
  const queryClient = useQueryClient();
  const [setup, setSetup] = useState<{ secret: string; otpauthUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [disableWith, setDisableWith] = useState("");
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["account", "me"] });
    void queryClient.invalidateQueries({ queryKey: authQueryKey });
  };
  const start = useMutation({ mutationFn: () => accountApi.mfaSetup(), onSuccess: (res) => setSetup(res) });
  const enable = useMutation({
    mutationFn: () => accountApi.mfaEnable(code.replace(/\s+/g, "")),
    onSuccess: () => {
      setSetup(null);
      setCode("");
      refresh();
    },
  });
  const disable = useMutation({
    mutationFn: () => {
      const v = disableWith.trim();
      return accountApi.mfaDisable(/^\d{6}$/.test(v.replace(/\s+/g, "")) ? { code: v.replace(/\s+/g, "") } : { password: v });
    },
    onSuccess: () => {
      setDisableWith("");
      refresh();
    },
  });
  const qr = useMemo(() => (setup ? qrSvg(setup.otpauthUrl, 4) : ""), [setup]);

  if (enabled) {
    return (
      <Section title="Two-factor authentication" description="Signing in requires a code from your authenticator app.">
        <div className={styles.statusRow}>
          <span className={styles.badgeOn}>On</span>
          <span className={styles.muted}>Authenticator app (TOTP)</span>
        </div>
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (disableWith.trim()) disable.mutate();
          }}
        >
          <label className={styles.label}>
            {hasPassword ? "Authentication code or password" : "Authentication code"}
            <input
              className={styles.input}
              type={hasPassword ? "password" : "text"}
              autoComplete="one-time-code"
              value={disableWith}
              onChange={(e) => setDisableWith(e.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button type="submit" className={styles.danger} disabled={!disableWith.trim() || disable.isPending}>
              {disable.isPending ? "Turning off…" : "Turn off two-factor authentication"}
            </button>
          </div>
          {disable.isError ? <Notice kind="error">{errorText(disable.error)}</Notice> : null}
        </form>
      </Section>
    );
  }

  return (
    <Section
      title="Two-factor authentication"
      description="Add a second step to sign-in with an authenticator app such as 1Password, Google Authenticator or Authy."
    >
      {!setup ? (
        <div className={styles.actions}>
          <button type="button" className={styles.primary} onClick={() => start.mutate()} disabled={start.isPending}>
            {start.isPending ? "Preparing…" : "Set up two-factor authentication"}
          </button>
          {start.isError ? <Notice kind="error">{errorText(start.error)}</Notice> : null}
        </div>
      ) : (
        <form
          className={styles.form}
          onSubmit={(e) => {
            e.preventDefault();
            enable.mutate();
          }}
        >
          <ol className={styles.steps}>
            <li>Scan this QR code with your authenticator app.</li>
          </ol>
          <div className={styles.qr} aria-label="Two-factor QR code" dangerouslySetInnerHTML={{ __html: qr }} />
          <p className={styles.muted}>
            Can’t scan it? Enter this key manually: <code className={styles.code}>{setup.secret}</code>
          </p>
          <ol className={styles.steps} start={2}>
            <li>Enter the 6-digit code the app shows.</li>
          </ol>
          <label className={styles.label}>
            Verification code
            <input
              className={`${styles.input} ${styles.codeInput}`}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={8}
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
          </label>
          <div className={styles.actions}>
            <button type="submit" className={styles.primary} disabled={code.replace(/\s+/g, "").length < 6 || enable.isPending}>
              {enable.isPending ? "Verifying…" : "Turn on"}
            </button>
            <button type="button" className={styles.secondary} onClick={() => setSetup(null)}>
              Cancel
            </button>
          </div>
          {enable.isError ? <Notice kind="error">{errorText(enable.error)}</Notice> : null}
        </form>
      )}
    </Section>
  );
}

function describeAgent(ua: string | null): string {
  if (!ua) return "Unknown device";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Chrome\//.test(ua)
      ? "Chrome"
      : /Firefox\//.test(ua)
        ? "Firefox"
        : /Safari\//.test(ua)
          ? "Safari"
          : ua.split(/[ /]/)[0] ?? "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function SessionsSection() {
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["account", "sessions"], queryFn: () => accountApi.sessions() });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["account", "sessions"] });
  const revoke = useMutation({ mutationFn: (id: string) => accountApi.revokeSession(id), onSuccess: invalidate });
  const revokeOthers = useMutation({ mutationFn: () => accountApi.revokeOtherSessions(), onSuccess: invalidate });
  const sessions: SessionInfo[] = q.data?.sessions ?? [];
  const others = sessions.filter((s) => !s.current).length;
  return (
    <Section title="Where you’re signed in" description="Sign out of sessions you don’t recognise.">
      {q.isLoading ? <p className={styles.muted}>Loading sessions…</p> : null}
      {q.isError ? <Notice kind="error">{errorText(q.error)}</Notice> : null}
      <ul className={styles.sessionList}>
        {sessions.map((s) => (
          <li key={s.id} className={styles.sessionItem}>
            <div className={styles.sessionText}>
              <span className={styles.sessionName}>
                {describeAgent(s.userAgent)}
                {s.current ? <span className={styles.badgeOn}>This device</span> : null}
              </span>
              <span className={styles.muted}>
                {s.ip ?? "Unknown IP"} · {s.authMethod === "oauth" ? "Google" : "Password"}
                {s.mfa ? " + 2FA" : ""} · last active {new Date(s.lastSeenAt).toLocaleString()}
              </span>
            </div>
            {!s.current ? (
              <button
                type="button"
                className={styles.secondary}
                disabled={revoke.isPending && revoke.variables === s.id}
                onClick={() => revoke.mutate(s.id)}
              >
                Sign out
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {others > 0 ? (
        <div className={styles.actions}>
          <button type="button" className={styles.secondary} onClick={() => revokeOthers.mutate()} disabled={revokeOthers.isPending}>
            Sign out of all other sessions
          </button>
        </div>
      ) : null}
      {revoke.isError ? <Notice kind="error">{errorText(revoke.error)}</Notice> : null}
      {revokeOthers.isError ? <Notice kind="error">{errorText(revokeOthers.error)}</Notice> : null}
    </Section>
  );
}

/** Account settings: profile, password, two-factor authentication, sessions. */
export function AccountPage({ onBack }: { onBack?: () => void }) {
  const me = useQuery({ queryKey: ["account", "me"], queryFn: () => accountApi.me() });
  const user = me.data?.user;
  return (
    <div className={styles.page}>
      <header className={styles.header}>
        {onBack ? (
          <button type="button" className={styles.back} onClick={onBack}>
            ← Back
          </button>
        ) : (
          <a className={styles.back} href="/">
            ← Home
          </a>
        )}
        <h1 className={styles.title}>Account</h1>
      </header>
      <main className={styles.main}>
        {me.isLoading ? <p className={styles.muted}>Loading…</p> : null}
        {me.isError ? <Notice kind="error">{errorText(me.error)}</Notice> : null}
        {user ? (
          <>
            <ProfileSection name={user.name} email={user.email} />
            <PasswordSection hasPassword={user.hasPassword !== false} />
            <MfaSection enabled={Boolean(user.mfaEnabled)} hasPassword={user.hasPassword !== false} />
            <SessionsSection />
          </>
        ) : null}
      </main>
    </div>
  );
}
