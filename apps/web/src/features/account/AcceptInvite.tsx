import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accountApi } from "../../lib/api-areas/account.ts";
import { ApiProblemError } from "../../lib/api.ts";
import { useMe } from "../auth/use-auth.ts";
import styles from "./account.module.css";

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) return err.problem.detail ?? err.problem.title;
  return err instanceof Error ? err.message : "Something went wrong";
}

const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  creator: "Creator",
  editor: "Editor",
  commenter: "Commenter",
  viewer: "Read only",
};

/**
 * `/invite/:token` page body. Shows who invited you to what, and accepts the
 * invitation for the signed-in user (whose email must match the invitation).
 * `onDone` receives where to go next (a base or the home page).
 */
export function AcceptInvite({
  token,
  onDone,
  onSignIn,
}: {
  token: string;
  onDone: (target: { baseId: string | null; workspaceId: string | null }) => void;
  /** Called when the visitor isn't signed in; route to /login?next=/invite/<token>. */
  onSignIn: () => void;
}) {
  const queryClient = useQueryClient();
  const preview = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => accountApi.previewInvitation(token),
    retry: false,
  });
  const me = useMe();
  const accept = useMutation({
    mutationFn: () => accountApi.acceptInvitation(token),
    onSuccess: (res) => {
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      onDone({ baseId: res.baseId, workspaceId: res.workspaceId });
    },
  });

  const inv = preview.data?.invitation;
  const myEmail = me.data?.email ?? "";
  const signedIn = Boolean(me.data);
  const target = inv?.baseName ?? inv?.workspaceName ?? "a workspace";
  const wrongAccount = signedIn && inv && myEmail.toLowerCase() !== inv.email.toLowerCase();

  return (
    <div className={styles.invitePage}>
      <div className={styles.inviteCard}>
        {preview.isLoading ? <p className={styles.muted}>Loading invitation…</p> : null}
        {preview.isError ? (
          <>
            <h1 className={styles.inviteTitle}>Invitation not found</h1>
            <p className={styles.muted}>This invitation link is invalid or has been revoked. Ask the person who invited you for a new link.</p>
          </>
        ) : null}
        {inv ? (
          <>
            <h1 className={styles.inviteTitle}>
              {inv.inviterName ? `${inv.inviterName} invited you` : "You’ve been invited"} to {target}
            </h1>
            <p className={styles.muted}>
              {inv.baseName ? "Base" : "Workspace"} access as <strong>{ROLE_LABEL[inv.role] ?? inv.role}</strong> · sent to {inv.email}
            </p>
            {inv.status !== "pending" ? (
              <div role="alert" className={styles.error}>
                {inv.status === "accepted"
                  ? "This invitation has already been accepted."
                  : inv.status === "expired"
                    ? "This invitation has expired. Ask for a new one."
                    : "This invitation was revoked."}
              </div>
            ) : !signedIn ? (
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={onSignIn}>
                  Sign in to accept
                </button>
              </div>
            ) : wrongAccount ? (
              <div role="alert" className={styles.error}>
                You’re signed in as {myEmail}. Sign in as {inv.email} to accept this invitation.
              </div>
            ) : (
              <div className={styles.actions}>
                <button type="button" className={styles.primary} onClick={() => accept.mutate()} disabled={accept.isPending}>
                  {accept.isPending ? "Joining…" : "Accept invitation"}
                </button>
              </div>
            )}
            {accept.isError ? (
              <div role="alert" className={styles.error}>
                {errorText(accept.error)}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
