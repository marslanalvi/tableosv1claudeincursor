import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Input, Label } from "@tabula/ui";
import {
  authErrorMessage,
  useLogin,
  useMfaVerify,
} from "../features/auth/use-auth.ts";
import authStyles from "../features/auth/auth-layout.module.css";

export function AuthTopNav() {
  return (
    <header className={authStyles.topNav}>
      <Link to="/" className={authStyles.wordmark}>
        <span className={authStyles.logo} aria-hidden>
          T
        </span>
        TableOS
      </Link>
    </header>
  );
}

export function LoginPage() {
  const search = useSearch({ strict: false }) as { next?: string };
  const next = search.next;
  const login = useLogin(next);
  const mfa = useMfaVerify(next);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const mfaToken =
    login.data && "mfaRequired" in login.data && login.data.mfaRequired
      ? login.data.mfaToken
      : null;

  return (
    <div className={authStyles.shell}>
      <AuthTopNav />
      <main className={authStyles.main}>
        <div className={authStyles.card}>
          <h1 className={authStyles.headline}>
            {mfaToken ? "Two-step verification" : "Sign in"}
          </h1>
          <p className={authStyles.sub}>
            {mfaToken
              ? "Enter the 6-digit code from your authenticator app."
              : next && next !== "/"
                ? "Your session ended. Sign in to continue where you left off."
                : "Welcome back to TableOS."}
          </p>
          {mfaToken ? (
            <form
              className={authStyles.form}
              onSubmit={(e) => {
                e.preventDefault();
                mfa.mutate({ mfaToken, code: code.trim() });
              }}
            >
              <div className={authStyles.field}>
                <Label htmlFor="code">Verification code</Label>
                <Input
                  id="code"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  autoFocus
                  required
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
              {mfa.isError ? (
                <p className={authStyles.error} role="alert">
                  {authErrorMessage(mfa.error).replace(
                    "Incorrect email or password.",
                    "That code didn't work. Try again.",
                  )}
                </p>
              ) : null}
              <Button type="submit" className={authStyles.submit} disabled={mfa.isPending}>
                {mfa.isPending ? "Verifying…" : "Verify"}
              </Button>
            </form>
          ) : (
            <form
              className={authStyles.form}
              onSubmit={(e) => {
                e.preventDefault();
                login.mutate({ email: email.trim(), password });
              }}
            >
              <div className={authStyles.field}>
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  autoFocus
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                />
              </div>
              <div className={authStyles.field}>
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </div>
              {login.isError ? (
                <p className={authStyles.error} role="alert">
                  {authErrorMessage(login.error, "login")}
                </p>
              ) : null}
              <Button type="submit" className={authStyles.submit} disabled={login.isPending}>
                {login.isPending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          )}
          <p className={authStyles.footer}>
            New to TableOS?{" "}
            <Link to="/signup" search={next ? { next } : {}}>
              Create an account
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
