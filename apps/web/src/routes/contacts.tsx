import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { ApiProblemError } from "../lib/api.ts";
import {
  contactsApi,
  relativeTime,
  type ContactInput,
  type ContactWire,
} from "../lib/api-areas/collab.ts";
import ui from "../features/share/surface.module.css";
import styles from "./contacts.module.css";

const FIELDS: { key: keyof ContactInput; label: string; type?: string; multiline?: boolean }[] = [
  { key: "name", label: "Name" },
  { key: "email", label: "Email", type: "email" },
  { key: "phone", label: "Phone", type: "tel" },
  { key: "company", label: "Company" },
  { key: "title", label: "Title" },
  { key: "notes", label: "Notes", multiline: true },
];

function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

function errorText(err: unknown): string {
  if (err instanceof ApiProblemError) return err.problem.detail ?? err.problem.title;
  return err instanceof Error ? err.message : "Something went wrong";
}

function initialsOf(c: ContactWire): string {
  const src = c.name || c.email || "?";
  const parts = src.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function ContactDialog({
  workspaceId,
  contact,
  onClose,
}: {
  workspaceId: string;
  contact: ContactWire | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<ContactInput>(() =>
    Object.fromEntries(FIELDS.map((f) => [f.key, (contact?.[f.key] as string | null | undefined) ?? ""])),
  );
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const done = () => {
    void qc.invalidateQueries({ queryKey: ["contacts", workspaceId] });
    onClose();
  };

  const save = useMutation({
    mutationFn: () => {
      const body: ContactInput = {};
      for (const f of FIELDS) {
        const v = (form[f.key] ?? "").trim();
        if (f.key === "name") {
          if (contact || v) body.name = v;
        } else if (contact) body[f.key] = v || null;
        else if (v) body[f.key] = v;
      }
      return contact ? contactsApi.update(workspaceId, contact.id, body) : contactsApi.create(workspaceId, body);
    },
    onSuccess: done,
    onError: (e) => setError(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => contactsApi.remove(workspaceId, contact!.id),
    onSuccess: done,
    onError: (e) => setError(errorText(e)),
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const canSave = Boolean((form.name ?? "").trim() || (form.email ?? "").trim());

  return (
    <div className={ui.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={ui.dialog} role="dialog" aria-modal="true" aria-labelledby="contact-dialog-title">
        <div className={ui.header}>
          <div style={{ flex: 1 }}>
            <h2 id="contact-dialog-title" className={ui.title}>
              {contact ? contact.name || contact.email || "Contact" : "New contact"}
            </h2>
            {contact ? <p className={ui.subtitle}>Updated {relativeTime(contact.updatedAt)}</p> : null}
          </div>
          <button type="button" className={ui.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) save.mutate();
          }}
        >
          <div className={ui.body}>
            {FIELDS.map((f) => (
              <label key={f.key} className={styles.formRow}>
                <span className={ui.label}>{f.label}</span>
                {f.multiline ? (
                  <textarea
                    className={ui.textarea}
                    rows={3}
                    value={form[f.key] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                ) : (
                  <input
                    className={ui.input}
                    type={f.type ?? "text"}
                    autoFocus={f.key === "name"}
                    value={form[f.key] ?? ""}
                    onChange={(e) => setForm((s) => ({ ...s, [f.key]: e.target.value }))}
                  />
                )}
              </label>
            ))}
            {error ? <p className={ui.error}>{error}</p> : null}
          </div>
          <div className={ui.footer}>
            {contact ? (
              confirmDelete ? (
                <>
                  <span className={ui.muted}>Delete this contact?</span>
                  <button type="button" className={ui.btnDanger} onClick={() => remove.mutate()} disabled={remove.isPending}>
                    {remove.isPending ? "Deleting…" : "Delete"}
                  </button>
                  <button type="button" className={ui.btnText} onClick={() => setConfirmDelete(false)}>
                    Keep
                  </button>
                </>
              ) : (
                <button type="button" className={ui.btnText} onClick={() => setConfirmDelete(true)}>
                  Delete contact
                </button>
              )
            ) : null}
            <span className={ui.footerSpacer} />
            <button type="button" className={ui.btnSecondary} onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className={ui.btnPrimary} disabled={!canSave || save.isPending}>
              {save.isPending ? "Saving…" : contact ? "Save" : "Create contact"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function MergeDialog({
  workspaceId,
  pair,
  onClose,
  onMerged,
}: {
  workspaceId: string;
  pair: [ContactWire, ContactWire];
  onClose: () => void;
  onMerged: () => void;
}) {
  const qc = useQueryClient();
  const [survivorId, setSurvivorId] = useState(pair[0].id);
  const [error, setError] = useState<string | null>(null);
  const survivor = pair.find((c) => c.id === survivorId)!;
  const merged = pair.find((c) => c.id !== survivorId)!;
  const merge = useMutation({
    mutationFn: () => contactsApi.merge(workspaceId, survivor.id, merged.id),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["contacts", workspaceId] });
      onMerged();
    },
    onError: (e) => setError(errorText(e)),
  });
  const preview = (k: keyof ContactInput) => (survivor[k] as string | null) || (merged[k] as string | null) || "—";

  return (
    <div className={ui.backdrop} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={ui.dialog} role="dialog" aria-modal="true" aria-labelledby="merge-title">
        <div className={ui.header}>
          <div style={{ flex: 1 }}>
            <h2 id="merge-title" className={ui.title}>
              Merge contacts
            </h2>
            <p className={ui.subtitle}>
              Pick the contact to keep. Its empty details are filled from the other one, links to the other contact move
              to it, and the other contact is deleted.
            </p>
          </div>
          <button type="button" className={ui.close} onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className={ui.body}>
          <div className={styles.mergeChoices} role="radiogroup" aria-label="Contact to keep">
            {pair.map((c) => (
              <button
                key={c.id}
                type="button"
                role="radio"
                aria-checked={c.id === survivorId}
                className={c.id === survivorId ? ui.radioCardActive : ui.radioCard}
                onClick={() => setSurvivorId(c.id)}
              >
                <strong>{c.name || "(no name)"}</strong>
                <span className={ui.muted}>{c.email ?? "no email"}</span>
                {c.id === survivorId ? <span className={ui.badge}>Keep</span> : null}
              </button>
            ))}
          </div>
          <table className={ui.table}>
            <tbody>
              {FIELDS.filter((f) => f.key !== "notes").map((f) => (
                <tr key={f.key}>
                  <th scope="row">{f.label}</th>
                  <td>{preview(f.key)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error ? <p className={ui.error}>{error}</p> : null}
        </div>
        <div className={ui.footer}>
          <span className={ui.footerSpacer} />
          <button type="button" className={ui.btnSecondary} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={ui.btnPrimary} onClick={() => merge.mutate()} disabled={merge.isPending}>
            {merge.isPending ? "Merging…" : "Merge"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function ContactsPage({ workspaceId }: { workspaceId: string }) {
  const [search, setSearch] = useState("");
  const q = useDebounced(search.trim(), 250);
  const [editing, setEditing] = useState<ContactWire | "new" | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [merging, setMerging] = useState(false);

  const contactsQuery = useQuery({
    queryKey: ["contacts", workspaceId, q],
    queryFn: () => contactsApi.list(workspaceId, q),
    placeholderData: (prev) => prev,
  });
  const contacts = useMemo(() => contactsQuery.data?.contacts ?? [], [contactsQuery.data]);
  const selectedContacts = contacts.filter((c) => selected.includes(c.id));

  function toggle(id: string) {
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id].slice(-2)));
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Link to="/" className={styles.back}>
          ← Home
        </Link>
        <div className={styles.headRow}>
          <div>
            <h1 className={styles.title}>Contacts</h1>
            <p className={styles.subtitle}>People your workspace works with. Link them from any base.</p>
          </div>
          <button type="button" className={ui.btnPrimary} onClick={() => setEditing("new")}>
            New contact
          </button>
        </div>
      </header>

      <div className={styles.toolbar}>
        <input
          type="search"
          className={`${ui.input} ${styles.search}`}
          placeholder="Search by name, email, company or phone"
          aria-label="Search contacts"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <span className={styles.spacer} />
        {selected.length > 0 ? (
          <>
            <span className={ui.muted}>
              {selected.length} selected{selected.length === 1 ? " · select one more to merge" : ""}
            </span>
            <button type="button" className={ui.btnText} onClick={() => setSelected([])}>
              Clear
            </button>
            <button
              type="button"
              className={ui.btnSecondary}
              disabled={selectedContacts.length !== 2}
              onClick={() => setMerging(true)}
            >
              Merge
            </button>
          </>
        ) : null}
      </div>

      {contactsQuery.isLoading ? (
        <p className={styles.state}>Loading contacts…</p>
      ) : contactsQuery.isError ? (
        <p className={styles.state}>Could not load contacts. {errorText(contactsQuery.error)}</p>
      ) : contacts.length === 0 ? (
        <div className={styles.empty}>
          <h2>{q ? `No contacts match “${q}”` : "No contacts yet"}</h2>
          <p>{q ? "Try a different search." : "Add the people you work with to keep their details in one place."}</p>
          {!q ? (
            <button type="button" className={ui.btnPrimary} onClick={() => setEditing("new")}>
              Add your first contact
            </button>
          ) : null}
        </div>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                <th className={styles.checkCol} aria-label="Select" />
                <th>Name</th>
                <th>Email</th>
                <th>Phone</th>
                <th>Company</th>
                <th>Title</th>
              </tr>
            </thead>
            <tbody>
              {contacts.map((c) => (
                <tr key={c.id} onClick={() => setEditing(c)} className={selected.includes(c.id) ? styles.rowSelected : undefined}>
                  <td className={styles.checkCol} onClick={(e) => e.stopPropagation()}>
                    <input
                      type="checkbox"
                      aria-label={`Select ${c.name || c.email}`}
                      checked={selected.includes(c.id)}
                      onChange={() => toggle(c.id)}
                    />
                  </td>
                  <td>
                    <span className={styles.nameCell}>
                      <span className={styles.avatar} aria-hidden>
                        {initialsOf(c)}
                      </span>
                      <span className={styles.name}>{c.name || <span className={ui.muted}>(no name)</span>}</span>
                    </span>
                  </td>
                  <td>{c.email ? <a href={`mailto:${c.email}`} onClick={(e) => e.stopPropagation()}>{c.email}</a> : null}</td>
                  <td>{c.phone}</td>
                  <td>{c.company}</td>
                  <td>{c.title}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className={styles.count}>
            {contacts.length} contact{contacts.length === 1 ? "" : "s"}
          </p>
        </div>
      )}

      {editing ? (
        <ContactDialog
          key={editing === "new" ? "new" : editing.id}
          workspaceId={workspaceId}
          contact={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {merging && selectedContacts.length === 2 ? (
        <MergeDialog
          workspaceId={workspaceId}
          pair={[selectedContacts[0]!, selectedContacts[1]!]}
          onClose={() => setMerging(false)}
          onMerged={() => {
            setMerging(false);
            setSelected([]);
          }}
        />
      ) : null}
    </div>
  );
}
