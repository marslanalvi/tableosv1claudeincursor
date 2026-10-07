/**
 * Live-API integration test for record revision history
 * (`GET /v1/bases/:b/tables/:t/records/:r/history`).
 *
 * Requires a running API (TABULA_API_URL, default http://localhost:3200).
 * Run: node --import tsx --test src/modules/records/history.integration.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const API = process.env["TABULA_API_URL"] ?? "http://localhost:3200";

type Res<T = any> = { status: number; body: T };

function client() {
  let cookie = "";
  return async <T = any>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    const res = await fetch(API + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
}

function ok<T>(r: Res<T>, status: number, what: string): T {
  assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const api = client();
const s: any = {};
const T = (t: string) => `/v1/bases/${s.baseId}/tables/${t}`;
const history = async (table: string, rec: string, qs = "") =>
  ok(await api("GET", `${T(table)}/records/${rec}/history${qs}`), 200, "history");

test("setup: user, base, fields, linked table", async () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const su = ok(
    await api("POST", "/v1/auth/signup", { email: `r2-grid-h${stamp}@tabula.test`, password: "Passw0rd!Passw0rd", name: "Hana History" }),
    201,
    "signup",
  );
  s.userId = su.user.id;
  const base = ok(await api("POST", `/v1/workspaces/${su.workspace.id}/bases`, { name: "History suite" }), 201, "create base");
  s.baseId = base.id;
  const detail = ok(await api("GET", `/v1/bases/${s.baseId}`), 200, "get base");
  const t = detail.tables[0];
  s.table = t.id;
  s.name = t.fields.find((f: any) => f.isPrimary).id;
  s.status = t.fields.find((f: any) => f.type === "single_select");
  s.qty = ok(await api("POST", `${T(s.table)}/fields`, { name: "Qty", type: "number", config: { precision: 0 } }), 201, "qty").field.id;
  s.temp = ok(await api("POST", `${T(s.table)}/fields`, { name: "Temp note", type: "text" }), 201, "temp").field.id;
  const p = ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "Projects" }), 201, "projects").table;
  s.projects = p.id;
  s.projName = p.fields.find((f: any) => f.isPrimary).id;
  s.link = ok(
    await api("POST", `${T(s.table)}/fields`, { name: "Project", type: "link", config: { linkedTableId: s.projects } }),
    201,
    "link field",
  ).field;
  s.proj = ok(await api("POST", `${T(s.projects)}/records`, { fields: { [s.projName]: "Apollo" } }), 201, "project").record.id;
});

test("create, edit several fields, link, unlink, delete, restore, undo", async () => {
  const rec = ok(await api("POST", `${T(s.table)}/records`, { fields: { [s.name]: "Alpha" } }), 201, "create").record;
  s.rec = rec.id;

  let h = await history(s.table, s.rec);
  assert.equal(h.entries.length, 1);
  assert.equal(h.entries[0].kind, "created");
  assert.equal(h.entries[0].actor.id, s.userId);
  assert.equal(h.entries[0].source, "user");
  assert.ok(!Number.isNaN(Date.parse(h.entries[0].at)));

  // One write, two fields → one entry with two changes.
  ok(await api("PATCH", `${T(s.table)}/records/${s.rec}`, { fields: { [s.name]: "Alpha 2", [s.qty]: 3 } }), 200, "patch 1");
  const todo = s.status.config.options[0];
  const done = s.status.config.options[2];
  ok(await api("PATCH", `${T(s.table)}/records/${s.rec}`, { fields: { [s.status.id]: todo.id, [s.temp]: "scratch" } }), 200, "patch 2");
  ok(await api("PATCH", `${T(s.table)}/records/${s.rec}`, { fields: { [s.status.id]: done.id, [s.qty]: 7 } }), 200, "patch 3");

  h = await history(s.table, s.rec);
  assert.deepEqual(h.entries.map((e: any) => e.kind), ["updated", "updated", "updated", "created"]);
  const [p3, p2, p1] = h.entries;
  const ch = (e: any, f: string) => e.changes.find((c: any) => c.fieldId === f);
  assert.equal(p1.changes.length, 2);
  assert.deepEqual(ch(p1, s.name), { fieldId: s.name, before: "Alpha", after: "Alpha 2" });
  assert.deepEqual(ch(p1, s.qty), { fieldId: s.qty, after: 3 });
  assert.equal(ch(p2, s.status.id).after, todo.id);
  assert.equal(ch(p2, s.temp).after, "scratch");
  assert.deepEqual(ch(p3, s.status.id), { fieldId: s.status.id, before: todo.id, after: done.id });
  assert.deepEqual(ch(p3, s.qty), { fieldId: s.qty, before: 3, after: 7 });
  assert.equal(h.fields[s.qty].name, "Qty");
  assert.equal(h.fields[s.qty].type, "number");
  assert.ok(h.fields[s.status.id].config.options.some((o: any) => o.id === done.id));
  assert.ok(h.entries.every((e: any) => e.seq > 0 && e.actor?.id === s.userId));

  // Link + unlink, seen from both sides.
  ok(await api("PATCH", `${T(s.table)}/records/${s.rec}`, { fields: { [s.link.id]: [s.proj] } }), 200, "link");
  h = await history(s.table, s.rec);
  assert.deepEqual(h.entries[0].changes, [{ fieldId: s.link.id, added: [{ id: s.proj, name: "Apollo" }], removed: [] }]);
  assert.equal(h.fields[s.link.id].type, "link");
  const ph = await history(s.projects, s.proj);
  assert.equal(ph.entries[0].kind, "updated");
  assert.deepEqual(ph.entries[0].changes, [{ fieldId: s.link.config.inverseFieldId, added: [{ id: s.rec, name: "Alpha 2" }], removed: [] }]);

  ok(await api("PATCH", `${T(s.table)}/records/${s.rec}`, { fields: { [s.link.id]: [] } }), 200, "unlink");
  h = await history(s.table, s.rec);
  assert.deepEqual(h.entries[0].changes, [{ fieldId: s.link.id, added: [], removed: [{ id: s.proj, name: "Apollo" }] }]);

  // Undo the unlink-free edit path: undo restores the value and the entry shows old → new.
  ok(await api("PATCH", `${T(s.table)}/records/${s.rec}`, { fields: { [s.qty]: 9 } }), 200, "patch qty 9");
  ok(await api("POST", `/v1/bases/${s.baseId}/undo`, {}), 200, "undo");
  h = await history(s.table, s.rec);
  assert.equal(h.entries[0].source, "undo");
  assert.deepEqual(ch(h.entries[0], s.qty), { fieldId: s.qty, before: 9, after: 7 });

  // Delete + restore; history stays readable while deleted.
  ok(await api("DELETE", `${T(s.table)}/records/${s.rec}`), 204, "delete");
  h = await history(s.table, s.rec);
  assert.equal(h.entries[0].kind, "deleted");
  ok(await api("POST", `/v1/bases/${s.baseId}/trash/restore`, { recordId: s.rec }), 200, "restore");
  h = await history(s.table, s.rec);
  assert.equal(h.entries[0].kind, "restored");
  assert.equal(h.entries[0].source, "restore");
  assert.deepEqual(
    h.entries.map((e: any) => e.kind),
    ["restored", "deleted", "updated", "updated", "updated", "updated", "updated", "updated", "updated", "created"],
  );
});

test("deleted fields keep their last name; pagination; duplicate; access", async () => {
  ok(await api("PATCH", `${T(s.table)}/fields/${s.temp}`, { name: "Scratch note" }), 200, "rename temp");
  ok(await api("DELETE", `${T(s.table)}/fields/${s.temp}`), 204, "delete temp");
  const h = await history(s.table, s.rec);
  const withTemp = h.entries.find((e: any) => e.changes.some((c: any) => c.fieldId === s.temp));
  assert.ok(withTemp, "change to the deleted field is still listed");
  assert.deepEqual(h.fields[s.temp], { id: s.temp, name: "Scratch note", type: "text", config: h.fields[s.temp].config, deleted: true });

  // Pagination: newest first, no overlap, same total.
  const seen: number[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: any = await history(s.table, s.rec, `?limit=3${cursor ? `&cursor=${cursor}` : ""}`);
    assert.ok(page.entries.length <= 3);
    seen.push(...page.entries.map((e: any) => e.seq));
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  assert.deepEqual(seen, h.entries.map((e: any) => e.seq));
  assert.deepEqual([...seen].sort((a, b) => b - a), seen);
  ok(await api("GET", `${T(s.table)}/records/${s.rec}/history?cursor=abc`), 422, "bad cursor");

  const dup = ok(await api("POST", `${T(s.table)}/records/${s.rec}/duplicate`, {}), 201, "duplicate").record;
  const dh = await history(s.table, dup.id);
  assert.equal(dh.entries.length, 1);
  assert.equal(dh.entries[0].kind, "created");
  assert.deepEqual(dh.entries[0].duplicatedFrom, { id: s.rec, name: "Alpha 2" });

  ok(await api("GET", `${T(s.table)}/records/rec_bad/history`), 422, "malformed id");

  const other = client();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  ok(
    await other("POST", "/v1/auth/signup", { email: `r2-grid-h${stamp}-x@tabula.test`, password: "Passw0rd!Passw0rd", name: "Outsider" }),
    201,
    "signup other",
  );
  const r = await other("GET", `${T(s.table)}/records/${s.rec}/history`);
  assert.equal(r.status, 404, "no access → 404");
});
