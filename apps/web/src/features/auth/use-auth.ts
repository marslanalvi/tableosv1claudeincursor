import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { api, ApiProblemError, request, type AuthUser } from "../../lib/api.ts";
import { shellApi } from "../../lib/api-areas/shell.ts";

export const authQueryKey = ["auth", "me"] as const;

export function useMe(enabled = true) {
  return useQuery({
    queryKey: authQueryKey,
    queryFn: () => api.me(),
    enabled,
    retry: false,
  });
}

/** Same-app relative paths only (open-redirect safe). */
export function safeNextPath(next: unknown): string {
  if (typeof next !== "string" || !next.startsWith("/") || next.startsWith("//")) return "/";
  if (next.startsWith("/login") || next.startsWith("/signup")) return "/";
  return next;
}

type LoginResponse =
  | { user: AuthUser; mfaRequired?: false }
  | { mfaRequired: true; mfaToken: string; user?: undefined };

function useFinishAuth(next?: string) {
  const queryClient = useQueryClient();
  const router = useRouter();
  return (user: AuthUser) => {
    // Drop anything cached for a previous account.
    queryClient.clear();
    queryClient.setQueryData(authQueryKey, user);
    void router.navigate({ href: safeNextPath(next) });
  };
}

export function useLogin(next?: string) {
  const finish = useFinishAuth(next);
  return useMutation({
    mutationFn: (body: { email: string; password: string }) =>
      request<LoginResponse>("/v1/auth/login", { method: "POST", json: body }),
    onSuccess: (res) => {
      if (res.user) finish(res.user);
    },
  });
}

export function useMfaVerify(next?: string) {
  const finish = useFinishAuth(next);
  return useMutation({
    mutationFn: (body: { mfaToken: string; code: string }) =>
      request<{ user: AuthUser }>("/v1/auth/mfa/verify", { method: "POST", json: body }),
    onSuccess: (res) => finish(res.user),
  });
}

export function useSignup(next?: string) {
  const finish = useFinishAuth(next);
  return useMutation({
    mutationFn: (body: { email: string; password: string; name: string }) =>
      api.signup(body),
    onSuccess: (user) => finish(user),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return useMutation({
    mutationFn: () => shellApi.logout(),
    onSettled: () => {
      queryClient.clear();
      void router.navigate({ to: "/login" });
    },
  });
}

export function authErrorMessage(error: unknown, mode: "login" | "signup" = "login"): string {
  if (error instanceof ApiProblemError) {
    const p = error.problem;
    if (p.status === 401) return "Incorrect email or password.";
    if (p.status === 429) return "Too many attempts. Please wait a minute and try again.";
    if (p.status === 409 || /exists|taken|already/i.test(p.detail ?? "")) {
      return mode === "signup"
        ? "An account with this email already exists. Try signing in instead."
        : (p.detail ?? "Conflict");
    }
    if (p.status === 422 && p.errors?.length) {
      const first = p.errors[0];
      const field = first?.field ?? "";
      if (field.includes("password")) {
        return mode === "signup"
          ? "Password must be at least 8 characters."
          : "Please enter your password.";
      }
      if (field.includes("email")) return "Please enter a valid email address.";
      if (field.includes("name")) return "Please enter your name.";
      return first?.message ?? p.detail ?? p.title;
    }
    if (p.status >= 500) return "The server is unavailable right now. Please try again.";
    return p.detail ?? p.title;
  }
  if (error instanceof TypeError) return "Can't reach the server. Check your connection.";
  if (error instanceof Error) return error.message;
  return "Something went wrong";
}
