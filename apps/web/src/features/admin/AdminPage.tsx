import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  adminApi,
  type ApiTokenInfo,
  type GrantRole,
  type OrgAccess,
  type OrgMember,
  type TokenScope,
} from "../../lib/api-areas/admin.ts";
import { accountApi } from "../../lib/api-areas/account.ts";
import { ApiProblemError } from "../../lib/api.ts";
import { copyText } from "../../lib/ids.ts";
import account from "../account/account.module.css";
import styles from "./admin.module.css";

const ROLES: { value: GrantRole; label: string; hint: string }[] = [
  { value: "creator", label: "Creator", hint: "Full control: edit data, change fields, tables and views" },
  { value: "editor", label: "Editor", hint: "Add, edit and delete records; create personal views" },
  { value: "commenter", label: "Commenter", hint: "Read everything and add comments" },
  { value: "viewer", label: "Viewer", hint: "Read only" },
];

export type AdminTab = "people" | "devices" | "tokens" | "settings";

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) {
    const p = err.problem as { detail?: string; title?: string; errors?: { message: string }[] };
    return p.errors?.[0]?.message ?? p.detail ?? p.title ?? "Something went wrong";
  }
  return err instanceof Error ? err.message : "Something went wrong";
}

const toDateInput = (iso: string | null) => (iso ? iso.slice(0, 10) : "");
/** End of the chosen local day, so "until 12 Oct" includes 12 Oct. */
const fromDateInput = (v: string) => (v ? new Date(`${v}T23:59:59`).toISOString() : null);
const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "—");

function Section({ title, description, actions, children }: { title: string; description?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={account.section}>
      <div className={styles.sectionHeadRow}>
        <div className={account.sectionHead}>
          <h2 className={account.sectionTitle}>{title}</h2>
          {description ? <p className={account.muted}>{description}</p> : null}
        </div>
        {actions}
      </div>
      <div className={account.sectionBody}>{children}</div>
    </section>
  );
}

function useAccess(orgId: string) {
  return useQuery({ queryKey: ["admin", "access", orgId], queryFn: () => adminApi.access(orgId), enabled: !!orgId });
}

function useInvalidateAccess(orgId: string) {
  const qc = useQueryClient();
  return () => void qc.invalidateQueries({ queryKey: ["admin", "access", orgId] });
}

/* ------------------------------------------------------------------ people */

function InviteForm({ orgId, data }: { orgId: string; data: OrgAccess }) {
  const refresh = useInvalidateAccess(orgId);
  const targets = useMemo(
    () =>
      data.workspaces.flatMap((w) => [
        { value: `wsp:${w.id}`, label: `Workspace · ${w.name} (all bases)` },
        ...w.bases.map((b) => ({ value: `bas:${b.id}`, label: `    Base · ${b.name}` })),
      ]),
    [data.workspaces],
  );
  const [email, setEmail] = useState("");
  const [target, setTarget] = useState(targets.find((t) => t.value.startsWith("bas:"))?.value ?? targets[0]?.value ?? "");
  const [role, setRole] = useState<GrantRole>("editor");
  const [link, setLink] = useState<string | null>(null);
  const invite = useMutation({
    mutationFn: () => {
      const [kind, id] = target.split(":") as ["wsp" | "bas", string];
      return accountApi.createInvitation({ email: email.trim(), role, ...(kind === "wsp" ? { workspaceId: id } : { baseId: id }) });
    },
    onSuccess: (res) => {
      setLink(res.invitation.acceptUrl);
      setEmail("");
      refresh();
    },
  });
  return (
    <form
      className={styles.inviteRow}
      onSubmit={(e) => {
        e.preventDefault();
        if (email.trim() && target) invite.mutate();
      }}
    >
      <input className={account.input} type="email" required placeholder="name@company.com" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
      <select className={account.input} value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Give access to">
        {targets.map((t) => (
          <option key={t.value} value={t.value}>
            {t.label}
          </option>
        ))}
      </select>
      <select className={account.input} value={role} onChange={(e) => setRole(e.target.value as GrantRole)} aria-label="Role">
        {ROLES.map((r) => (
          <option key={r.value} value={r.value} title={r.hint}>
            {r.label}
          </option>
        ))}
      </select>
      <button type="submit" className={account.primary} disabled={invite.isPending || !email.trim()}>
        {invite.isPending ? "Inviting…" : "Invite"}
      </button>
      {invite.isError ? <div className={account.error}>{errorText(invite.error)}</div> : null}
      {link ? (
        <div className={`${account.ok} ${styles.full}`}>
          Invitation sent. You can also share this link: <code className={account.code}>{link}</code>{" "}
          <button type="button" className={styles.linkBtn} onClick={() => void copyText(link)}>
            Copy
          </button>
        </div>
      ) : null}
    </form>
  );
}

function AccessRow({
  orgId,
  member,
  label,
  indent,
  scope,
  inherited,
}: {
  orgId: string;
  member: OrgMember;
  label: string;
  indent: boolean;
  scope: { workspaceId: string } | { baseId: string };
  inherited: string | null;
}) {
  const refresh = useInvalidateAccess(orgId);
  const id = "workspaceId" in scope ? scope.workspaceId : scope.baseId;
  const grant = member.grants.find((g) => g.resourceId === id);
  const save = useMutation({
    mutationFn: (body: { role: GrantRole | null; expiresAt?: string | null }) => adminApi.setGrant(orgId, member.id, { ...scope, ...body }),
    onSettled: refresh,
  });
  return (
    <tr>
      <td className={indent ? styles.indent : styles.strong}>{label}</td>
      <td>
        <select
          className={`${account.input} ${styles.compact}`}
          value={grant?.role ?? ""}
          disabled={save.isPending}
          onChange={(e) => save.mutate({ role: (e.target.value || null) as GrantRole | null, expiresAt: grant?.expiresAt ?? null })}
          aria-label={`Role on ${label}`}
        >
          <option value="">{inherited ? `Inherit (${inherited})` : "No access"}</option>
          {ROLES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
      </td>
      <td>
        <input
          type="date"
          className={`${account.input} ${styles.compact}`}
          disabled={!grant || save.isPending}
          value={toDateInput(grant?.expiresAt ?? null)}
          min={new Date().toISOString().slice(0, 10)}
          onChange={(e) => grant && save.mutate({ role: grant.role as GrantRole, expiresAt: fromDateInput(e.target.value) })}
          aria-label={`Access until on ${label}`}
        />
      </td>
      <td className={styles.state}>
        {save.isError ? <span className={styles.bad}>{errorText(save.error)}</span> : grant?.expired ? <span className={styles.bad}>Expired</span> : grant?.expiresAt ? "Time-limited" : grant ? "No end date" : ""}
      </td>
    </tr>
  );
}

function MemberCard({ orgId, member, data }: { orgId: string; member: OrgMember; data: OrgAccess }) {
  const refresh = useInvalidateAccess(orgId);
  const [open, setOpen] = useState(false);
  const status = useMutation({
    mutationFn: (s: "active" | "suspended") => adminApi.setMemberStatus(orgId, member.id, s),
    onSettled: refresh,
  });
  const remove = useMutation({ mutationFn: () => adminApi.removeMember(orgId, member.id), onSettled: refresh });
  const pending = member.devices.filter((d) => d.status === "pending").length;
  const approved = member.devices.filter((d) => d.status === "approved").length;
  const summary = member.isOwner
    ? "Owner · full access to everything"
    : member.grants.length === 0
      ? "No access yet"
      : `${member.grants.length} access rule${member.grants.length === 1 ? "" : "s"}`;
  return (
    <li className={styles.member}>
      <div className={styles.memberHead}>
        <div className={account.sessionText}>
          <span className={account.sessionName}>
            {member.name || member.email}
            {member.isOwner ? <span className={account.badgeOn}>Owner</span> : null}
            {member.status === "suspended" ? <span className={styles.badgeWarn}>Suspended</span> : null}
            {pending ? <span className={styles.badgeWarn}>{pending} device{pending === 1 ? "" : "s"} waiting</span> : null}
          </span>
          <span className={account.muted}>
            {member.email} · {summary}
            {!member.isOwner ? ` · ${approved} approved device${approved === 1 ? "" : "s"}` : ""}
          </span>
        </div>
        {!member.isOwner ? (
          <div className={account.actions}>
            <button type="button" className={account.secondary} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
              {open ? "Done" : "Edit access"}
            </button>
            <button
              type="button"
              className={account.secondary}
              disabled={status.isPending}
              onClick={() => status.mutate(member.status === "active" ? "suspended" : "active")}
            >
              {member.status === "active" ? "Suspend" : "Reactivate"}
            </button>
            <button
              type="button"
              className={account.danger}
              disabled={remove.isPending}
              onClick={() => {
                if (window.confirm(`Remove ${member.name || member.email}? They lose access to every workspace and base here.`)) remove.mutate();
              }}
            >
              Remove
            </button>
          </div>
        ) : null}
      </div>
      {status.isError ? <div className={account.error}>{errorText(status.error)}</div> : null}
      {remove.isError ? <div className={account.error}>{errorText(remove.error)}</div> : null}
      {open ? (
        <table className={styles.matrix}>
          <thead>
            <tr>
              <th>Workspace / base</th>
              <th>Role</th>
              <th>Access until</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.workspaces.map((w) => {
              const wsRole = member.grants.find((g) => g.resourceId === w.id)?.role ?? null;
              return [
                <AccessRow key={w.id} orgId={orgId} member={member} label={w.name} indent={false} scope={{ workspaceId: w.id }} inherited={null} />,
                ...w.bases.map((b) => (
                  <AccessRow key={b.id} orgId={orgId} member={member} label={b.name} indent scope={{ baseId: b.id }} inherited={wsRole} />
                )),
              ];
            })}
          </tbody>
        </table>
      ) : null}
    </li>
  );
}

function PeopleSection({ orgId, data }: { orgId: string; data: OrgAccess }) {
  const refresh = useInvalidateAccess(orgId);
  const revoke = useMutation({ mutationFn: (id: string) => accountApi.revokeInvitation(id), onSettled: refresh });
  const nameOf = (i: OrgAccess["invitations"][number]) => {
    for (const w of data.workspaces) {
      if (i.workspaceId === w.id) return `${w.name} (workspace)`;
      const b = w.bases.find((x) => x.id === i.baseId);
      if (b) return b.name;
    }
    return "—";
  };
  return (
    <>
      <Section
        title="Invite people"
        description="Only you, the owner, can invite people. Give them a role on a whole workspace or on a single base; you can change it, set an end date or remove it at any time."
      >
        <InviteForm orgId={orgId} data={data} />
        {data.invitations.length ? (
          <ul className={account.sessionList}>
            {data.invitations.map((i) => (
              <li key={i.id} className={account.sessionItem}>
                <div className={account.sessionText}>
                  <span className={account.sessionName}>{i.email}</span>
                  <span className={account.muted}>
                    Invited as {i.role} to {nameOf(i)} · link expires {new Date(i.expiresAt).toLocaleDateString()}
                  </span>
                </div>
                <button type="button" className={account.secondary} onClick={() => revoke.mutate(i.id)} disabled={revoke.isPending}>
                  Cancel invite
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>
      <Section
        title="Members"
        description="A workspace role applies to every base in that workspace. A base role gives access to that base only. People only see what you give them."
      >
        <ul className={styles.memberList}>
          {data.members.map((m) => (
            <MemberCard key={m.id} orgId={orgId} member={m} data={data} />
          ))}
        </ul>
      </Section>
    </>
  );
}

/* ----------------------------------------------------------------- devices */

function DevicesSection({ orgId, data }: { orgId: string; data: OrgAccess }) {
  const refresh = useInvalidateAccess(orgId);
  const update = useMutation({
    mutationFn: (v: { id: string; status?: "approved" | "revoked"; label?: string }) =>
      adminApi.updateDevice(orgId, v.id, { ...(v.status ? { status: v.status } : {}), ...(v.label !== undefined ? { label: v.label } : {}) }),
    onSettled: refresh,
  });
  const del = useMutation({ mutationFn: (id: string) => adminApi.deleteDevice(orgId, id), onSettled: refresh });
  const rows = data.members
    .filter((m) => !m.isOwner)
    .flatMap((m) => m.devices.map((d) => ({ ...d, member: m })))
    .sort((a, b) => (a.status === "pending" ? -1 : 0) - (b.status === "pending" ? -1 : 0));
  return (
    <Section
      title="Devices"
      description={
        data.org.requireDeviceApproval
          ? "Each person can only open your data from devices you approve. A new browser or computer shows up here as “Waiting” the first time they sign in. Approve it, or revoke it later to cut that device off immediately."
          : "Device approval is turned off (see Security), so any signed-in device works. Revoked devices stay blocked."
      }
    >
      {rows.length === 0 ? <p className={account.muted}>No devices yet. They appear when invited people sign in.</p> : null}
      <ul className={account.sessionList}>
        {rows.map((d) => (
          <li key={d.id} className={account.sessionItem}>
            <div className={account.sessionText}>
              <span className={account.sessionName}>
                {d.member.name || d.member.email} — {d.label}
                <span className={d.status === "approved" ? account.badgeOn : styles.badgeWarn}>
                  {d.status === "pending" ? "Waiting for approval" : d.status === "approved" ? "Approved" : "Revoked"}
                </span>
              </span>
              <span className={account.muted}>
                {d.lastIp ?? "Unknown IP"} · first seen {fmt(d.firstSeenAt)} · last active {fmt(d.lastSeenAt)}
              </span>
            </div>
            <div className={account.actions}>
              <button
                type="button"
                className={styles.linkBtn}
                onClick={() => {
                  const label = window.prompt("Device name", d.label);
                  if (label && label.trim()) update.mutate({ id: d.id, label: label.trim() });
                }}
              >
                Rename
              </button>
              {d.status !== "approved" ? (
                <button type="button" className={account.primary} onClick={() => update.mutate({ id: d.id, status: "approved" })} disabled={update.isPending}>
                  Approve
                </button>
              ) : null}
              {d.status !== "revoked" ? (
                <button type="button" className={account.danger} onClick={() => update.mutate({ id: d.id, status: "revoked" })} disabled={update.isPending}>
                  {d.status === "pending" ? "Deny" : "Revoke"}
                </button>
              ) : (
                <button type="button" className={account.secondary} onClick={() => del.mutate(d.id)} disabled={del.isPending}>
                  Forget
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
      {update.isError ? <div className={account.error}>{errorText(update.error)}</div> : null}
    </Section>
  );
}

/* ------------------------------------------------------------------ tokens */

const SCOPES: { value: TokenScope; label: string; hint: string }[] = [
  { value: "read", label: "Read", hint: "List, query and fetch records; read base and table info" },
  { value: "write", label: "Write", hint: "Create and update records, set links" },
  { value: "delete", label: "Delete", hint: "Delete records" },
];

function TokensSection({ orgId, data }: { orgId: string; data: OrgAccess }) {
  const qc = useQueryClient();
  const tokens = useQuery({ queryKey: ["admin", "tokens", orgId], queryFn: () => adminApi.tokens(orgId) });
  const allBases = data.workspaces.flatMap((w) => w.bases.map((b) => ({ ...b, workspace: w.name })));
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState<Set<TokenScope>>(new Set(["read"]));
  const [allBasesOn, setAllBasesOn] = useState(true);
  const [bases, setBases] = useState<Set<string>>(new Set());
  const [days, setDays] = useState("90");
  const [created, setCreated] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () =>
      adminApi.createToken(orgId, {
        name: name.trim(),
        scopes: [...scopes],
        baseIds: allBasesOn ? null : [...bases],
        expiresAt: days === "never" ? null : new Date(Date.now() + Number(days) * 86400_000).toISOString(),
      }),
    onSuccess: (res) => {
      setCreated(res.token);
      setName("");
      void qc.invalidateQueries({ queryKey: ["admin", "tokens", orgId] });
    },
  });
  const revoke = useMutation({
    mutationFn: (id: string) => adminApi.revokeToken(orgId, id),
    onSettled: () => void qc.invalidateQueries({ queryKey: ["admin", "tokens", orgId] }),
  });
  const toggle = <T,>(set: Set<T>, v: T) => {
    const next = new Set(set);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    return next;
  };
  const baseName = (id: string) => allBases.find((b) => b.id === id)?.name ?? id;
  const describe = (t: ApiTokenInfo) =>
    `${t.scopes.join(" + ")} · ${t.baseIds ? t.baseIds.map(baseName).join(", ") : "all bases"} · ${t.expiresAt ? `expires ${new Date(t.expiresAt).toLocaleDateString()}` : "never expires"} · last used ${t.lastUsedAt ? fmt(t.lastUsedAt) : "never"}`;
  return (
    <>
      <Section
        title="Create an API token"
        description={
          <>
            Tokens let your own scripts and tools use the record API with your permissions. Choose what the token may do and which bases it can reach.
            See the <a href="/help/api">API reference</a> for endpoints and examples.
          </>
        }
      >
        <form
          className={account.form}
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim() && scopes.size && (allBasesOn || bases.size)) create.mutate();
          }}
        >
          <label className={account.label}>
            Name
            <input className={account.input} placeholder="e.g. Website sync" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} />
          </label>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Token type</legend>
            {SCOPES.map((s) => (
              <label key={s.value} className={styles.check}>
                <input type="checkbox" checked={scopes.has(s.value)} onChange={() => setScopes((v) => toggle(v, s.value))} />
                <span>
                  <strong>{s.label}</strong> <span className={account.muted}>— {s.hint}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.legend}>Bases</legend>
            <label className={styles.check}>
              <input type="radio" checked={allBasesOn} onChange={() => setAllBasesOn(true)} /> All bases, including future ones
            </label>
            <label className={styles.check}>
              <input type="radio" checked={!allBasesOn} onChange={() => setAllBasesOn(false)} /> Only these bases:
            </label>
            {!allBasesOn ? (
              <div className={styles.baseChecks}>
                {allBases.map((b) => (
                  <label key={b.id} className={styles.check}>
                    <input type="checkbox" checked={bases.has(b.id)} onChange={() => setBases((v) => toggle(v, b.id))} />
                    {b.name} <span className={account.muted}>({b.workspace})</span>
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>
          <label className={account.label}>
            Expires
            <select className={account.input} value={days} onChange={(e) => setDays(e.target.value)}>
              <option value="30">In 30 days</option>
              <option value="90">In 90 days</option>
              <option value="365">In 1 year</option>
              <option value="never">Never</option>
            </select>
          </label>
          <div className={account.actions}>
            <button type="submit" className={account.primary} disabled={create.isPending || !name.trim() || !scopes.size || (!allBasesOn && !bases.size)}>
              {create.isPending ? "Creating…" : "Create token"}
            </button>
          </div>
          {create.isError ? <div className={account.error}>{errorText(create.error)}</div> : null}
        </form>
        {created ? (
          <div className={account.ok} role="status">
            Copy your token now. For security it won’t be shown again.
            <div className={styles.tokenBox}>
              <code className={account.code}>{created}</code>
              <button type="button" className={account.secondary} onClick={() => void copyText(created)}>
                Copy
              </button>
            </div>
          </div>
        ) : null}
      </Section>
      <Section title="Tokens">
        {tokens.isLoading ? <p className={account.muted}>Loading…</p> : null}
        {tokens.data?.tokens.length === 0 ? <p className={account.muted}>No tokens yet.</p> : null}
        <ul className={account.sessionList}>
          {tokens.data?.tokens.map((t) => (
            <li key={t.id} className={account.sessionItem}>
              <div className={account.sessionText}>
                <span className={account.sessionName}>
                  {t.name} <code className={account.code}>{t.prefix}…</code>
                  <span className={t.status === "active" ? account.badgeOn : styles.badgeWarn}>{t.status}</span>
                </span>
                <span className={account.muted}>{describe(t)}</span>
              </div>
              {t.status === "active" ? (
                <button
                  type="button"
                  className={account.danger}
                  disabled={revoke.isPending}
                  onClick={() => {
                    if (window.confirm(`Revoke “${t.name}”? Anything using it stops working immediately.`)) revoke.mutate(t.id);
                  }}
                >
                  Revoke
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      </Section>
    </>
  );
}

/* ---------------------------------------------------------------- settings */

function SettingsSection({ orgId, data }: { orgId: string; data: OrgAccess }) {
  const refresh = useInvalidateAccess(orgId);
  const save = useMutation({
    mutationFn: (v: boolean) => adminApi.setSettings(orgId, { requireDeviceApproval: v }),
    onSettled: refresh,
  });
  return (
    <Section title="Security" description="These rules apply to everyone except you, the owner.">
      <label className={styles.check}>
        <input type="checkbox" checked={data.org.requireDeviceApproval} disabled={save.isPending} onChange={(e) => save.mutate(e.target.checked)} />
        <span>
          <strong>Require device approval</strong>
          <span className={account.muted}>
            {" "}
            — people can only use approved computers and browsers. This replaces MAC-address allowlists: web browsers can’t read a MAC address, so TableOS gives each browser its own private device key that you approve.
          </span>
        </span>
      </label>
      {save.isError ? <div className={account.error}>{errorText(save.error)}</div> : null}
    </Section>
  );
}

/* -------------------------------------------------------------------- page */

export function AdminPage({ tab, onTab, onBack }: { tab: AdminTab; onTab: (t: AdminTab) => void; onBack: () => void }) {
  const orgs = useQuery({ queryKey: ["admin", "orgs"], queryFn: () => adminApi.orgs() });
  const owned = orgs.data?.orgs.filter((o) => o.isOwner) ?? [];
  const [orgId, setOrgId] = useState<string>("");
  useEffect(() => {
    if (!orgId && owned[0]) setOrgId(owned[0].id);
  }, [orgId, owned]);
  const access = useAccess(orgId);
  const data = orgId ? access.data : undefined;
  const tabs: { id: AdminTab; label: string; count?: number }[] = [
    { id: "people", label: "People" },
    { id: "devices", label: "Devices", ...(data?.pendingDevices ? { count: data.pendingDevices } : {}) },
    { id: "tokens", label: "API tokens" },
    { id: "settings", label: "Security" },
  ];
  return (
    <div className={account.page}>
      <header className={account.header}>
        <button type="button" className={account.back} onClick={onBack}>
          ← Back
        </button>
        <h1 className={account.title}>Members &amp; access</h1>
        {owned.length > 1 ? (
          <select className={`${account.input} ${styles.compact}`} value={orgId} onChange={(e) => setOrgId(e.target.value)} aria-label="Organization">
            {owned.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        ) : null}
      </header>
      <main className={`${account.main} ${styles.wide}`}>
        {orgs.isLoading ? <p className={account.muted}>Loading…</p> : null}
        {orgs.data && owned.length === 0 ? (
          <div className={account.section}>
            <h2 className={account.sectionTitle}>Only the owner can manage access</h2>
            <p className={account.muted}>Ask the owner of your workspace to invite people, change roles or approve devices.</p>
          </div>
        ) : null}
        {data ? (
          <>
            <nav className={styles.tabs} role="tablist">
              {tabs.map((t) => (
                <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? styles.tabOn : styles.tab} onClick={() => onTab(t.id)}>
                  {t.label}
                  {t.count ? <span className={styles.count}>{t.count}</span> : null}
                </button>
              ))}
            </nav>
            {tab === "people" ? <PeopleSection orgId={orgId} data={data} /> : null}
            {tab === "devices" ? <DevicesSection orgId={orgId} data={data} /> : null}
            {tab === "tokens" ? <TokensSection orgId={orgId} data={data} /> : null}
            {tab === "settings" ? <SettingsSection orgId={orgId} data={data} /> : null}
          </>
        ) : null}
        {access.isError ? <div className={account.error}>{errorText(access.error)}</div> : null}
      </main>
    </div>
  );
}
