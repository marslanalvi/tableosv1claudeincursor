import { Link, useRouter } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api, type BaseSummary, type Workspace } from "../lib/api.ts";
import { shellApi } from "../lib/api-areas/shell.ts";
import { useMe } from "../features/auth/use-auth.ts";
import { AccountMenu } from "../features/base/AccountMenu.tsx";
import {
  Avatar,
  ConfirmDialog,
  Dialog,
  DropdownMenu,
  PromptDialog,
  uiStyles,
} from "../app/ui.tsx";
import { toast, errorMessage } from "../app/toast.tsx";
import styles from "./home.module.css";

const BASE_COLORS = [
  "#aa2d00",
  "#0a2e0e",
  "#181d26",
  "#254fad",
  "#d9a441",
  "#7a8f3a",
  "#a8577e",
  "#2f7d7a",
];

export function baseColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return BASE_COLORS[h % BASE_COLORS.length] ?? "#181d26";
}

function baseInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2);
  return `${words[0]![0]}${words[1]![0]}`;
}

/* ------------------------------------------------------------------ */

function CreateBaseDialog({
  workspaces,
  defaultWorkspaceId,
  onClose,
}: {
  workspaces: Workspace[];
  defaultWorkspaceId: string;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const router = useRouter();
  const [name, setName] = useState("Untitled Base");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId);
  const [mode, setMode] = useState<"blank" | "import">("blank");
  const create = useMutation({
    mutationFn: () => api.createBase(workspaceId, name.trim()),
    onSuccess: async (base) => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces", workspaceId, "bases"] });
      onClose();
      void router.navigate({
        to: "/bases/$baseId",
        params: { baseId: base.id },
        search: mode === "import" ? { import: "1" } : {},
      });
    },
  });
  return (
    <Dialog
      title="Create a base"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={uiStyles.btn} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={uiStyles.btnPrimary}
            disabled={!name.trim() || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create base"}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) create.mutate();
        }}
      >
        <div className={uiStyles.field}>
          <label className={uiStyles.label} htmlFor="new-base-name">
            Name
          </label>
          <input
            id="new-base-name"
            className={uiStyles.input}
            value={name}
            autoFocus
            onFocus={(e) => e.currentTarget.select()}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        {workspaces.length > 1 ? (
          <div className={uiStyles.field}>
            <label className={uiStyles.label} htmlFor="new-base-ws">
              Workspace
            </label>
            <select
              id="new-base-ws"
              className={uiStyles.select}
              value={workspaceId}
              onChange={(e) => setWorkspaceId(e.target.value)}
            >
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className={uiStyles.label}>Start with</div>
        <div className={styles.startOptions}>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "blank"}
            onClick={() => setMode("blank")}
          >
            <strong>Start from scratch</strong>
            <span>An empty table you can shape yourself.</span>
          </button>
          <button
            type="button"
            className={styles.startOption}
            data-active={mode === "import"}
            onClick={() => setMode("import")}
          >
            <strong>Import a CSV</strong>
            <span>Bring rows in from a spreadsheet file.</span>
          </button>
        </div>
        {create.isError ? <p className={uiStyles.error}>{errorMessage(create.error)}</p> : null}
      </form>
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

function MembersDialog({
  workspace,
  onClose,
}: {
  workspace: Workspace;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const membersQuery = useQuery({
    queryKey: ["workspaces", workspace.id, "members"],
    queryFn: () => shellApi.workspaceMembers(workspace.id),
  });
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => shellApi.invite(workspace.id, email.trim(), role),
    onSuccess: (res) => {
      toast.success(`Invitation sent to ${res.invitation.email}`);
      setEmail("");
      if (res.invitation.acceptToken) {
        setInviteLink(
          `${window.location.origin}/invite?token=${encodeURIComponent(res.invitation.acceptToken)}`,
        );
      }
      void queryClient.invalidateQueries({ queryKey: ["workspaces", workspace.id, "members"] });
    },
  });
  return (
    <Dialog title={`Share “${workspace.name}”`} onClose={onClose} wide>
      <form
        className={styles.inviteRow}
        onSubmit={(e) => {
          e.preventDefault();
          if (email.trim()) invite.mutate();
        }}
      >
        <input
          className={uiStyles.input}
          type="email"
          placeholder="Invite by email"
          value={email}
          required
          onChange={(e) => setEmail(e.target.value)}
        />
        <select
          className={uiStyles.select}
          style={{ width: 140 }}
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label="Role"
        >
          <option value="owner">Owner</option>
          <option value="creator">Creator</option>
          <option value="editor">Editor</option>
          <option value="commenter">Commenter</option>
          <option value="viewer">Read only</option>
        </select>
        <button
          type="submit"
          className={uiStyles.btnPrimary}
          disabled={!email.trim() || invite.isPending}
        >
          {invite.isPending ? "Inviting…" : "Invite"}
        </button>
      </form>
      {invite.isError ? <p className={uiStyles.error}>{errorMessage(invite.error)}</p> : null}
      {inviteLink ? (
        <p className={styles.inviteLink}>
          Invite link (share it if email isn’t configured):{" "}
          <input className={uiStyles.input} readOnly value={inviteLink} onFocus={(e) => e.currentTarget.select()} />
        </p>
      ) : null}
      <h3 className={styles.membersTitle}>Workspace members</h3>
      {membersQuery.isLoading ? (
        <p className={uiStyles.muted}>Loading…</p>
      ) : membersQuery.isError ? (
        <p className={uiStyles.error}>{errorMessage(membersQuery.error)}</p>
      ) : (
        <ul className={styles.memberList}>
          {(membersQuery.data?.members ?? []).map((m) => (
            <li key={m.id} className={styles.memberRow}>
              <Avatar name={m.name} id={m.id} />
              <div className={styles.memberText}>
                <div>{m.name}</div>
                <div className={uiStyles.muted}>{m.email}</div>
              </div>
              <span className={styles.roleTag}>{m.role}</span>
            </li>
          ))}
          {(membersQuery.data?.invitations ?? []).map((inv) => (
            <li key={inv.id} className={styles.memberRow}>
              <Avatar name={inv.email} id={inv.id} color="#9297a0" />
              <div className={styles.memberText}>
                <div>{inv.email}</div>
                <div className={uiStyles.muted}>Invitation pending</div>
              </div>
              <span className={styles.roleTag}>{inv.role}</span>
            </li>
          ))}
        </ul>
      )}
    </Dialog>
  );
}

/* ------------------------------------------------------------------ */

type BaseDialog =
  | { kind: "rename"; base: BaseSummary }
  | { kind: "delete"; base: BaseSummary }
  | null;

function BaseCard({
  base,
  onRename,
  onDuplicate,
  onDelete,
}: {
  base: BaseSummary;
  onRename: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const router = useRouter();
  return (
    <div className={styles.baseCard}>
      <Link to="/bases/$baseId" params={{ baseId: base.id }} className={styles.baseCardLink}>
        <span className={styles.baseIcon} style={{ background: baseColor(base.id) }} aria-hidden>
          {baseInitials(base.name)}
        </span>
        <span className={styles.baseCardText}>
          <span className={styles.baseName}>{base.name}</span>
          <span className={styles.baseMeta}>Base</span>
        </span>
      </Link>
      <div className={styles.baseCardMenu}>
        <DropdownMenu
          align="right"
          trigger={({ toggle }) => (
            <button
              type="button"
              className={uiStyles.iconBtn}
              aria-label={`Options for ${base.name}`}
              onClick={toggle}
            >
              ⋯
            </button>
          )}
          items={[
            {
              key: "open",
              label: "Open",
              icon: "↗",
              onSelect: () =>
                void router.navigate({ to: "/bases/$baseId", params: { baseId: base.id } }),
            },
            { key: "rename", label: "Rename", icon: "✎", onSelect: onRename },
            { key: "dup", label: "Duplicate", icon: "⧉", onSelect: onDuplicate },
            {
              key: "copy",
              label: "Copy base ID",
              icon: "#",
              onSelect: () => {
                void navigator.clipboard
                  ?.writeText(base.id)
                  .then(() => toast.success("Base ID copied"))
                  .catch(() => toast.info(base.id));
              },
            },
            {
              key: "delete",
              label: "Delete",
              icon: "🗑",
              danger: true,
              separatorBefore: true,
              onSelect: onDelete,
            },
          ]}
        />
      </div>
    </div>
  );
}

function WorkspaceSection({
  workspace,
  workspaces,
}: {
  workspace: Workspace;
  workspaces: Workspace[];
}) {
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<BaseDialog>(null);
  const [creating, setCreating] = useState(false);
  const [renamingWs, setRenamingWs] = useState(false);
  const [sharing, setSharing] = useState(false);
  const basesKey = ["workspaces", workspace.id, "bases"];
  const basesQuery = useQuery({
    queryKey: basesKey,
    queryFn: () => api.workspaceBases(workspace.id),
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: basesKey });

  const rename = useMutation({
    mutationFn: (v: { baseId: string; name: string }) => shellApi.renameBase(v.baseId, v.name),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast.success("Base renamed");
    },
  });
  const duplicate = useMutation({
    mutationFn: (base: BaseSummary) => shellApi.duplicateBase(base.id, { name: `${base.name} copy` }),
    onSuccess: async (res) => {
      await refresh();
      toast.success(`Created “${res.name}”`);
    },
    onError: (err) => toast.error(err, "Could not duplicate base"),
  });
  const remove = useMutation({
    mutationFn: (baseId: string) => shellApi.deleteBase(baseId),
    onSuccess: async () => {
      await refresh();
      setDialog(null);
      toast.success("Base deleted");
    },
    onError: (err) => toast.error(err, "Could not delete base"),
  });
  const renameWs = useMutation({
    mutationFn: (name: string) => shellApi.renameWorkspace(workspace.id, name),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"], exact: true });
      setRenamingWs(false);
      toast.success("Workspace renamed");
    },
  });

  const bases = basesQuery.data?.bases ?? [];

  return (
    <section className={styles.workspaceSection} id={`ws-${workspace.id}`}>
      <div className={styles.workspaceHeader}>
        <h2 className={styles.workspaceTitle}>{workspace.name}</h2>
        <div className={styles.workspaceActions}>
          <button type="button" className={uiStyles.btn} onClick={() => setSharing(true)}>
            Share
          </button>
          <DropdownMenu
            align="right"
            trigger={({ toggle }) => (
              <button
                type="button"
                className={uiStyles.iconBtn}
                aria-label="Workspace options"
                onClick={toggle}
              >
                ⋯
              </button>
            )}
            items={[
              { key: "rename", label: "Rename workspace", icon: "✎", onSelect: () => setRenamingWs(true) },
              { key: "members", label: "Members and invites", icon: "👥", onSelect: () => setSharing(true) },
              { key: "contacts", label: "Contacts", icon: "☎", onSelect: () => {
                  window.location.assign(`/contacts?workspaceId=${encodeURIComponent(workspace.id)}`);
                } },
            ]}
          />
        </div>
      </div>

      {basesQuery.isLoading ? (
        <p className={uiStyles.muted}>Loading bases…</p>
      ) : basesQuery.isError ? (
        <p className={uiStyles.error}>{errorMessage(basesQuery.error, "Could not load bases")}</p>
      ) : (
        <div className={styles.baseGrid}>
          {bases.map((base) => (
            <BaseCard
              key={base.id}
              base={base}
              onRename={() => setDialog({ kind: "rename", base })}
              onDuplicate={() => duplicate.mutate(base)}
              onDelete={() => setDialog({ kind: "delete", base })}
            />
          ))}
          <button type="button" className={styles.createCard} onClick={() => setCreating(true)}>
            <span className={styles.createPlus} aria-hidden>
              +
            </span>
            Create a base
          </button>
        </div>
      )}
      {bases.length === 0 && basesQuery.isSuccess ? (
        <p className={uiStyles.muted}>No bases yet. Create one to get started.</p>
      ) : null}

      {creating ? (
        <CreateBaseDialog
          workspaces={workspaces}
          defaultWorkspaceId={workspace.id}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {sharing ? <MembersDialog workspace={workspace} onClose={() => setSharing(false)} /> : null}
      {renamingWs ? (
        <PromptDialog
          title="Rename workspace"
          label="Workspace name"
          initialValue={workspace.name}
          busy={renameWs.isPending}
          error={renameWs.isError ? errorMessage(renameWs.error) : null}
          onSubmit={(v) => renameWs.mutate(v)}
          onClose={() => setRenamingWs(false)}
        />
      ) : null}
      {dialog?.kind === "rename" ? (
        <PromptDialog
          title="Rename base"
          label="Base name"
          initialValue={dialog.base.name}
          busy={rename.isPending}
          error={rename.isError ? errorMessage(rename.error) : null}
          onSubmit={(name) => rename.mutate({ baseId: dialog.base.id, name })}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "delete" ? (
        <ConfirmDialog
          title="Delete base?"
          message={
            <>
              <strong>{dialog.base.name}</strong> and all of its tables, records and automations
              will be deleted for everyone in this workspace.
            </>
          }
          confirmLabel="Delete base"
          busy={remove.isPending}
          onConfirm={() => remove.mutate(dialog.base.id)}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </section>
  );
}

export function HomePage() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [creatingWs, setCreatingWs] = useState(false);
  const workspacesQuery = useQuery({
    queryKey: ["workspaces"],
    queryFn: () => api.workspaces(),
    enabled: me.isSuccess,
  });
  const workspaces = workspacesQuery.data?.workspaces ?? [];
  const createWs = useMutation({
    mutationFn: (name: string) => shellApi.createWorkspace(name),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({ queryKey: ["workspaces"], exact: true });
      setCreatingWs(false);
      toast.success(`Workspace “${res.workspace.name}” created`);
    },
  });

  useEffect(() => {
    document.title = "Home · Tabula";
  }, []);

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.wordmark}>
          <span className={styles.logo} aria-hidden>
            T
          </span>
          Tabula
        </Link>
        <button
          type="button"
          className={styles.searchHint}
          onClick={() =>
            window.dispatchEvent(
              new KeyboardEvent("keydown", { key: "k", ctrlKey: true, metaKey: true }),
            )
          }
        >
          Search… <kbd>Ctrl K</kbd>
        </button>
        <div className={styles.headerActions}>
          <AccountMenu />
        </div>
      </header>
      <div className={styles.body}>
        <nav className={styles.sidebar} aria-label="Workspaces">
          <div className={styles.sidebarLabel}>Workspaces</div>
          {workspaces.map((w) => (
            <a key={w.id} href={`#ws-${w.id}`} className={styles.sidebarItem}>
              {w.name}
            </a>
          ))}
          <button
            type="button"
            className={styles.sidebarCreate}
            onClick={() => setCreatingWs(true)}
          >
            + Create workspace
          </button>
        </nav>
        <main className={styles.main}>
          <h1 className={styles.pageTitle}>
            {me.data?.name ? `Welcome, ${me.data.name.split(" ")[0]}` : "Home"}
          </h1>
          {workspacesQuery.isLoading ? (
            <p className={uiStyles.muted}>Loading…</p>
          ) : workspacesQuery.isError ? (
            <p className={uiStyles.error}>
              {errorMessage(workspacesQuery.error, "Could not load workspaces")}
            </p>
          ) : workspaces.length === 0 ? (
            <div className={styles.emptyState}>
              <p>You don’t have a workspace yet.</p>
              <button type="button" className={uiStyles.btnPrimary} onClick={() => setCreatingWs(true)}>
                Create workspace
              </button>
            </div>
          ) : (
            workspaces.map((w) => (
              <WorkspaceSection key={w.id} workspace={w} workspaces={workspaces} />
            ))
          )}
        </main>
      </div>
      {creatingWs ? (
        <PromptDialog
          title="Create workspace"
          label="Workspace name"
          initialValue="My workspace"
          confirmLabel="Create"
          busy={createWs.isPending}
          error={createWs.isError ? errorMessage(createWs.error) : null}
          onSubmit={(name) => createWs.mutate(name)}
          onClose={() => setCreatingWs(false)}
        />
      ) : null}
    </div>
  );
}
