import { Link, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Input, Label } from "@tabula/ui";
import { authErrorMessage, useSignup } from "../features/auth/use-auth.ts";
import authStyles from "../features/auth/auth-layout.module.css";
import { AuthTopNav } from "./login.tsx";

export function SignupPage() {
  const search = useSearch({ strict: false }) as { next?: string };
  const next = search.next;
  const signup = useSignup(next);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const tooShort = password.length > 0 && password.length < 8;

  return (
    <div className={authStyles.shell}>
      <AuthTopNav />
      <main className={authStyles.main}>
        <div className={authStyles.card}>
          <h1 className={authStyles.headline}>Create your account</h1>
          <p className={authStyles.sub}>Start organizing your work in Tabula.</p>
          <form
            className={authStyles.form}
            onSubmit={(e) => {
              e.preventDefault();
              if (password.length < 8) return;
              signup.mutate({ name: name.trim(), email: email.trim(), password });
            }}
          >
            <div className={authStyles.field}>
              <Label htmlFor="name">Full name</Label>
              <Input
                id="name"
                autoComplete="name"
                autoFocus
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className={authStyles.field}>
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="email"
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
                autoComplete="new-password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className={authStyles.hint} style={tooShort ? { color: "var(--tabula-color-danger)" } : undefined}>
                At least 8 characters.
              </span>
            </div>
            {signup.isError ? (
              <p className={authStyles.error} role="alert">
                {authErrorMessage(signup.error, "signup")}
              </p>
            ) : null}
            <Button
              type="submit"
              className={authStyles.submit}
              disabled={signup.isPending || tooShort}
            >
              {signup.isPending ? "Creating account…" : "Create account"}
            </Button>
          </form>
          <p className={authStyles.footer}>
            Already have an account?{" "}
            <Link to="/login" search={next ? { next } : {}}>
              Sign in
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
