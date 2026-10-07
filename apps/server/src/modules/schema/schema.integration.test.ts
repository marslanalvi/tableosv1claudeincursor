/**
 * Live-API integration suite for workstream B: field types, schema ops,
 * links, computed fields and record writes.
 *
 * Requires a running API (TABULA_API_URL, default http://localhost:3200).
 * Run: node --import tsx --test src/modules/schema/schema.integration.test.ts
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodePublicId, encodePublicId, generateUuidV7 } from "@tabula/types";
// @ts-ignore -- no @types/pg in this workspace; test-only helper
import pg from "pg";

const API = process.env["TABULA_API_URL"] ?? "http://localhost:3200";
const DB_URL = process.env["DATABASE_URL"] ?? "postgres://tabula:tabula@localhost:5432/tabula_cc";

type Res<T = any> = { status: number; body: T };

function client() {
  let cookie = "";
  return async <T = any>(method: string, path: string, body?: unknown): Promise<Res<T>> => {
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(API + path, {
          method,
          headers: {
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(cookie ? { cookie } : {}),
          },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        break;
      } catch (e) {
        if (attempt > 30) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
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

const api = client();
const s: any = {};

function ok<T>(r: Res<T>, status: number, what: string): T {
  assert.equal(r.status, status, `${what}: expected ${status}, got ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

const T = (t: string) => `/v1/bases/${s.baseId}/tables/${t}`;

async function addField(table: string, body: Record<string, unknown>): Promise<any> {
  return ok(await api("POST", `${T(table)}/fields`, body), 201, `create field ${String(body["name"])}`).field;
}

async function getRecord(table: string, id: string): Promise<any> {
  return ok(await api("GET", `${T(table)}/records/${id}`), 200, "get record").record;
}

async function tableFields(table: string): Promise<any[]> {
  return ok(await api("GET", `${T(table)}/fields`), 200, "list fields").fields;
}

async function tableInfo(table: string): Promise<any> {
  const r = ok(await api("GET", `/v1/bases/${s.baseId}/tables`), 200, "list tables");
  return r.tables.find((t: any) => t.id === table);
}

test("signup + new base gets an Airtable-like default table", async () => {
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const su = ok(
    await api("POST", "/v1/auth/signup", { email: `ws-b-${stamp}@tabula.test`, password: "Passw0rd!Passw0rd!", name: "Bea Builder" }),
    201,
    "signup",
  );
  s.userId = su.user.id;
  s.wsId = su.workspace.id;
  const base = ok(await api("POST", `/v1/workspaces/${s.wsId}/bases`, { name: "B suite" }), 201, "create base");
  s.baseId = base.id;
  const detail = ok(await api("GET", `/v1/bases/${s.baseId}`), 200, "get base");
  const t = detail.tables[0];
  assert.deepEqual(
    t.fields.map((f: any) => [f.name, f.type]),
    [
      ["Name", "text"],
      ["Notes", "long_text"],
      ["Assignee", "collaborator"],
      ["Status", "single_select"],
      ["Attachments", "attachment"],
    ],
  );
  const status = t.fields.find((f: any) => f.name === "Status");
  assert.deepEqual(status.config.options.map((o: any) => o.label), ["Todo", "In progress", "Done"]);
  for (const o of status.config.options) {
    assert.match(o.id, /^opt_/);
    assert.ok(o.color);
  }
  assert.equal(t.fields[0].isPrimary, true);
  for (const f of t.fields) {
    assert.match(f.id, /^fld_/);
    assert.ok("description" in f && "isComputed" in f && "slot" in f);
  }
  const q = ok(await api("POST", `${T(t.id)}/records/query`, {}), 200, "query");
  assert.equal(q.records.length, 3);
});

test("tables: create, rename, conflict, plan of fields", async () => {
  const p = ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "Projects" }), 201, "create Projects").table;
  const t = ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "Tasks" }), 201, "create Tasks").table;
  s.projects = p.id;
  s.tasks = t.id;
  s.pName = p.fields.find((f: any) => f.isPrimary).id;
  s.tName = t.fields.find((f: any) => f.isPrimary).id;
  ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "projects" }), 409, "dup table name");
  const r = ok(await api("PATCH", T(s.tasks), { name: "Work items" }), 200, "rename").table;
  assert.equal(r.name, "Work items");
  ok(await api("PATCH", T(s.tasks), { name: "Tasks" }), 200, "rename back");
  const info = await tableInfo(s.tasks);
  assert.equal(info.recordCount, 3);
});

test("field types: create every type, reject unsupported", async () => {
  const specs: Array<[string, string, Record<string, unknown>?]> = [
    ["Num", "number", { precision: 2 }],
    ["Price", "currency", { symbol: "$", precision: 2 }],
    ["Pct", "percent"],
    ["Dur", "duration", { format: "h:mm" }],
    ["Done", "checkbox"],
    ["Due", "date"],
    ["When", "datetime", { timeFormat: "24h" }],
    ["Prio", "single_select", { options: [{ label: "High" }, { label: "Low" }] }],
    ["Tags", "multi_select", { options: [{ label: "red" }] }],
    ["Mail", "email"],
    ["Site", "url"],
    ["Tel", "phone"],
    ["Stars", "rating", { max: 5 }],
    ["Owner", "collaborator", { allowMultiple: true }],
    ["Files", "attachment"],
    ["Code", "barcode"],
    ["Go", "button", { label: "Open", action: { type: "open_url", url: "https://example.com" } }],
    ["Data", "json"],
    ["Auto", "autonumber"],
    ["CTime", "created_time"],
    ["MTime", "modified_time"],
    ["CBy", "created_by"],
    ["MBy", "modified_by"],
    ["Words", "text"],
  ];
  s.f = {};
  for (const [name, type, config] of specs) {
    const f = await addField(s.tasks, { name, type, ...(config ? { config } : {}) });
    assert.equal(f.type, type);
    s.f[name] = f;
  }
  for (const o of s.f.Prio.config.options) assert.match(o.id, /^opt_/);
  assert.equal(s.f.Stars.config.max, 5);
  assert.equal(s.f.Auto.isReadOnly, true);
  ok(await api("POST", `${T(s.tasks)}/fields`, { name: "AI", type: "ai_generated" }), 422, "ai_generated");
  ok(await api("POST", `${T(s.tasks)}/fields`, { name: "Bogus", type: "bogus" }), 422, "unknown type");
  ok(await api("POST", `${T(s.tasks)}/fields`, { name: "num", type: "text" }), 409, "dup field name");
  ok(await api("POST", `${T(s.tasks)}/fields`, { name: "R2", type: "rating", config: { max: 50 } }), 422, "bad config");
});

test("record writes: typecast, normalization, wire format, errors", async () => {
  const f = s.f;
  const res = ok(
    await api("POST", `${T(s.tasks)}/records`, {
      typecast: true,
      fields: {
        [s.tName]: "Write spec",
        [f.Num.id]: "12.5",
        [f.Price.id]: "9.99",
        [f.Dur.id]: 3600,
        [f.Done.id]: true,
        [f.Due.id]: "2026-03-04",
        [f.When.id]: "2026-03-04T10:00:00Z",
        [f.Prio.id]: "High",
        [f.Tags.id]: ["red", "blue"],
        [f.Mail.id]: "a@b.co",
        [f.Owner.id]: s.userId,
        [f.Code.id]: "ABC-1",
        [f.Data.id]: { a: [1, 2] },
        [f.Stars.id]: 4,
      },
    }),
    201,
    "create record",
  ).record;
  s.r1 = res.id;
  assert.match(res.id, /^rec_/);
  assert.equal(res.version, 1);
  assert.ok(res.createdAt && res.updatedAt && res.manualOrder && res.rowNumber);
  const v = res.fields;
  assert.equal(v[f.Num.id], 12.5);
  assert.equal(v[f.Price.id], 9.99);
  assert.equal(v[f.Done.id], true);
  assert.equal(v[f.Due.id], "2026-03-04");
  assert.match(v[f.When.id], /^2026-03-04T10:00:00/);
  assert.equal(v[f.Prio.id], f.Prio.config.options.find((o: any) => o.label === "High").id);
  assert.equal(v[f.Tags.id].length, 2);
  for (const t of v[f.Tags.id]) assert.match(t, /^opt_/);
  assert.equal(v[f.Owner.id][0].id, s.userId);
  assert.equal(v[f.Owner.id][0].name, "Bea Builder");
  assert.deepEqual(v[f.Code.id], { text: "ABC-1" });
  assert.deepEqual(v[f.Data.id], { a: [1, 2] });
  assert.equal(v[f.Auto.id], res.rowNumber);
  assert.equal(v[f.CBy.id].id, s.userId);
  assert.ok(v[f.CTime.id]);
  assert.equal(v[f.Go.id], undefined);
  // typecast created the "blue" option
  const fields = await tableFields(s.tasks);
  assert.ok(fields.find((x) => x.id === f.Tags.id).config.options.some((o: any) => o.label === "blue"));

  // PATCH returns the new version and full fields
  const p = ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Num.id]: 7 } }), 200, "patch").record;
  assert.equal(p.version, 2);
  assert.equal(p.fields[f.Num.id], 7);
  assert.equal(p.fields[s.tName], "Write spec");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Num.id]: 8 }, version: 1 }), 409, "stale version");
  // clearing values
  const c = ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Done.id]: false, [f.Mail.id]: null } }), 200, "clear").record;
  assert.equal(c.fields[f.Done.id], undefined);
  assert.equal(c.fields[f.Mail.id], undefined);

  // errors
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Auto.id]: 3 } }), 422, "read-only");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { fld_doesnotexist: 3 } }), 422, "unknown field");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Num.id]: "abc" } }), 422, "bad number");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Prio.id]: "Nope" } }), 422, "unknown option w/o typecast");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.r1}`, { fields: { [f.Owner.id]: "usr_bogus" } }), 422, "bad user id");
  ok(await api("POST", `${T(s.tasks)}/records/batch`, { records: [] }), 422, "empty batch");
  ok(await api("POST", `${T(s.tasks)}/records/batch-delete`, { ids: [] }), 422, "empty batch delete");
  const missing = encodePublicId({ prefix: "rec", uuid: generateUuidV7() });
  ok(await api("DELETE", `${T(s.tasks)}/records/${missing}`), 404, "delete missing");
});

test("record batch ops, duplicate, move, counters", async () => {
  const before = (await tableInfo(s.tasks)).recordCount;
  const b = ok(
    await api("POST", `${T(s.tasks)}/records/batch`, {
      records: [{ fields: { [s.tName]: "B1" } }, { fields: { [s.tName]: "B2" } }],
    }),
    201,
    "batch create",
  ).records;
  assert.equal(b.length, 2);
  assert.equal((await tableInfo(s.tasks)).recordCount, before + 2);
  const bp = ok(
    await api("PATCH", `${T(s.tasks)}/records/batch`, {
      records: b.map((r: any, i: number) => ({ id: r.id, fields: { [s.f.Num.id]: i + 1 } })),
    }),
    200,
    "batch patch",
  ).records;
  assert.deepEqual(bp.map((r: any) => [r.fields[s.f.Num.id], r.version]), [[1, 2], [2, 2]]);
  ok(
    await api("PATCH", `${T(s.tasks)}/records/batch`, {
      records: [{ id: b[0].id, fields: {} }, { id: b[0].id, fields: {} }],
    }),
    422,
    "duplicate ids",
  );
  const d = ok(await api("POST", `${T(s.tasks)}/records/${s.r1}/duplicate`, {}), 201, "duplicate").record;
  assert.notEqual(d.id, s.r1);
  assert.equal(d.fields[s.tName], "Write spec");
  assert.equal((await tableInfo(s.tasks)).recordCount, before + 3);
  // move B2 to the top
  const m = ok(await api("POST", `${T(s.tasks)}/records/${b[1].id}/move`, { before: null, after: null }), 200, "move").record;
  const q = ok(await api("POST", `${T(s.tasks)}/records/query`, {}), 200, "query").records;
  assert.equal(q[0].id, m.id);
  ok(await api("POST", `${T(s.tasks)}/records/batch-delete`, { ids: [b[0].id, d.id] }), 204, "batch delete");
  ok(await api("DELETE", `${T(s.tasks)}/records/${b[1].id}`), 204, "delete");
  ok(await api("DELETE", `${T(s.tasks)}/records/${b[1].id}`), 404, "delete twice");
  assert.equal((await tableInfo(s.tasks)).recordCount, before);
});

test("links: create via POST fields, inverse field, both directions, no clobbering", async () => {
  const link = await addField(s.tasks, { name: "Project", type: "link", config: { linkedTableId: s.projects } });
  s.link = link;
  assert.equal(link.config.linkedTableId, s.projects);
  assert.match(link.config.inverseFieldId, /^fld_/);
  const pf = await tableFields(s.projects);
  const inv = pf.find((x) => x.id === link.config.inverseFieldId);
  assert.ok(inv, "inverse field exists");
  assert.equal(inv.name, "Tasks");
  assert.equal(inv.config.linkedTableId, s.tasks);
  s.inv = inv;

  const pr = ok(await api("POST", `${T(s.projects)}/records/query`, {}), 200, "projects").records;
  const ps = [];
  for (const [i, r] of pr.entries()) {
    ps.push(ok(await api("PATCH", `${T(s.projects)}/records/${r.id}`, { fields: { [s.pName]: `P${i + 1}` } }), 200, "name").record);
  }
  s.p = ps.map((r: any) => r.id);
  const tr = ok(await api("POST", `${T(s.tasks)}/records/query`, {}), 200, "tasks").records;
  s.t = tr.map((r: any) => r.id);
  for (const [i, id] of s.t.entries()) {
    if (id !== s.r1) ok(await api("PATCH", `${T(s.tasks)}/records/${id}`, { fields: { [s.tName]: `T${i + 1}` } }), 200, "task name");
  }

  // Task0 -> P1, P2 ; Task1 -> P1
  const w = ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [link.id]: [s.p[0], s.p[1]] } }), 200, "link").record;
  assert.deepEqual(w.fields[link.id], [
    { id: s.p[0], name: "P1" },
    { id: s.p[1], name: "P2" },
  ]);
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[1]}`, { fields: { [link.id]: [s.p[0]] } }), 200, "link 2");
  let p1 = await getRecord(s.projects, s.p[0]);
  assert.deepEqual(p1.fields[inv.id].map((x: any) => x.id).sort(), [s.t[0], s.t[1]].sort());
  // editing an unrelated field on the peer must not drop links (data-loss bug)
  ok(await api("PATCH", `${T(s.projects)}/records/${s.p[0]}`, { fields: { [s.pName]: "P1" } }), 200, "edit peer");
  p1 = await getRecord(s.projects, s.p[0]);
  assert.equal(p1.fields[inv.id].length, 2);
  const t0 = await getRecord(s.tasks, s.t[0]);
  assert.equal(t0.fields[link.id].length, 2);
  // writing from the other side replaces that side
  ok(await api("PATCH", `${T(s.projects)}/records/${s.p[1]}`, { fields: { [inv.id]: [s.t[2]] } }), 200, "inverse write");
  const t0b = await getRecord(s.tasks, s.t[0]);
  assert.deepEqual(t0b.fields[link.id].map((x: any) => x.id), [s.p[0]]);
  const t2 = await getRecord(s.tasks, s.t[2]);
  assert.deepEqual(t2.fields[link.id].map((x: any) => x.id), [s.p[1]]);
  // bad targets
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [link.id]: [s.t[1]] } }), 422, "target in wrong table");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [link.id]: ["rec_nope"] } }), 422, "malformed target");
});

test("computed: lookup / rollup / count / formula chains across tables", async () => {
  // Tasks: hours (number). Projects: Total = rollup sum(hours), N = count, Double = {Total} * 2, Label = formula on name.
  const hours = await addField(s.tasks, { name: "Hours", type: "number" });
  s.hours = hours;
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [hours.id]: 3 } }), 200, "h0");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[1]}`, { fields: { [hours.id]: 4 } }), 200, "h1");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[2]}`, { fields: { [hours.id]: 10 } }), 200, "h2");

  const total = await addField(s.projects, {
    name: "Total",
    type: "rollup",
    config: { linkFieldId: s.inv.id, targetFieldId: hours.id, aggregation: "sum" },
  });
  const n = await addField(s.projects, { name: "N", type: "count", config: { linkFieldId: s.inv.id } });
  const dbl = await addField(s.projects, { name: "Double", type: "formula", config: { expression: "{Total} * 2" } });
  assert.equal(dbl.config.expression, "{Total} * 2");
  assert.equal(dbl.isComputed, true);
  const names = await addField(s.projects, {
    name: "Task names",
    type: "lookup",
    config: { linkFieldId: s.inv.id, targetFieldId: s.tName },
  });
  // backfill
  let p1 = await getRecord(s.projects, s.p[0]);
  assert.equal(p1.fields[total.id], 7);
  assert.equal(p1.fields[n.id], 2);
  assert.equal(p1.fields[dbl.id], 14);
  assert.equal(p1.fields[names.id].length, 2);

  // a write in Tasks propagates to Projects (rollup -> formula)
  const w = ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [hours.id]: 5 } }), 200, "h0b").record;
  assert.equal(w.fields[hours.id], 5);
  p1 = await getRecord(s.projects, s.p[0]);
  assert.equal(p1.fields[total.id], 9);
  assert.equal(p1.fields[dbl.id], 18);

  // link change updates count/rollup on both old and new peers
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[1]}`, { fields: { [s.link.id]: [s.p[1]] } }), 200, "relink");
  p1 = await getRecord(s.projects, s.p[0]);
  const p2 = await getRecord(s.projects, s.p[1]);
  assert.equal(p1.fields[n.id], 1);
  assert.equal(p1.fields[total.id], 5);
  assert.equal(p2.fields[n.id], 2);
  assert.equal(p2.fields[total.id], 14);

  // lookup of a computed field in the other direction + formula on lookup
  const projTotal = await addField(s.tasks, {
    name: "Project total",
    type: "lookup",
    config: { linkFieldId: s.link.id, targetFieldId: total.id },
  });
  const t1 = await getRecord(s.tasks, s.t[1]);
  assert.deepEqual(t1.fields[projTotal.id], [14]);
  const share = await addField(s.tasks, {
    name: "Share",
    type: "formula",
    config: { expression: "ROUND({Hours} / SUM({Project total}) * 100, 0)", resultType: "number" },
  });
  assert.equal((await getRecord(s.tasks, s.t[1])).fields[share.id], 29);
  // lookup of a link field returns {id,name}
  const pt = await addField(s.tasks, {
    name: "Siblings",
    type: "lookup",
    config: { linkFieldId: s.link.id, targetFieldId: s.inv.id },
  });
  const sib = (await getRecord(s.tasks, s.t[1])).fields[pt.id];
  assert.ok(Array.isArray(sib) && sib.length === 2, JSON.stringify(sib));
  for (const x of sib) assert.match(x.id, /^rec_/);
  // rollup concat over a link target uses names
  const cat = await addField(s.tasks, {
    name: "Sibling names",
    type: "rollup",
    config: { linkFieldId: s.link.id, targetFieldId: s.inv.id, aggregation: "concat" },
  });
  const catV = (await getRecord(s.tasks, s.t[1])).fields[cat.id];
  assert.equal(typeof catV, "string");
  assert.ok(!/[0-9a-f]{8}-/.test(catV), catV);
  // renaming a sibling (two hops away) refreshes the concat rollup
  const sibling = sib.find((x: any) => x.id !== s.t[1]);
  ok(await api("PATCH", `${T(s.tasks)}/records/${sibling.id}`, { fields: { [s.tName]: "Renamed sibling" } }), 200, "rename sibling");
  assert.match((await getRecord(s.tasks, s.t[1])).fields[cat.id], /Renamed sibling/);
  // a formula over a link field shows linked names and follows renames
  const linkNames = await addField(s.projects, { name: "Task list", type: "formula", config: { expression: 'ARRAYJOIN({Tasks}, "|")' } });
  ok(await api("PATCH", `${T(s.tasks)}/records/${sibling.id}`, { fields: { [s.tName]: "Sib2" } }), 200, "rename again");
  assert.match((await getRecord(s.projects, s.p[1])).fields[linkNames.id], /Sib2/);

  // deleting a linked task updates the project
  const extra = ok(await api("POST", `${T(s.tasks)}/records`, { fields: { [s.tName]: "tmp", [hours.id]: 100, [s.link.id]: [s.p[1]] } }), 201, "tmp").record;
  assert.equal((await getRecord(s.projects, s.p[1])).fields[total.id], 114);
  ok(await api("DELETE", `${T(s.tasks)}/records/${extra.id}`), 204, "del tmp");
  assert.equal((await getRecord(s.projects, s.p[1])).fields[total.id], 14);
  s.total = total;
  s.dbl = dbl;
});

test("formulas: errors, names, cycles, rename keeps references", async () => {
  const bad = await addField(s.tasks, { name: "Bad", type: "formula", config: { expression: "1 / 0" } });
  const r = await getRecord(s.tasks, s.t[0]);
  assert.equal(r.fields[bad.id], undefined);
  assert.ok(r.errors && typeof r.errors[bad.id] === "string", JSON.stringify(r.errors));
  ok(await api("POST", `${T(s.tasks)}/fields`, { name: "Syn", type: "formula", config: { expression: "1 +" } }), 422, "syntax");
  ok(await api("POST", `${T(s.tasks)}/fields`, { name: "Unk", type: "formula", config: { expression: "{Nope} + 1" } }), 422, "unknown ref");
  const a = await addField(s.tasks, { name: "FA", type: "formula", config: { expression: "{Hours} + 1" } });
  const b = await addField(s.tasks, { name: "FB", type: "formula", config: { expression: "{FA} * 10" } });
  assert.equal((await getRecord(s.tasks, s.t[0])).fields[b.id], 60);
  const cyc = await api("PATCH", `${T(s.tasks)}/fields/${a.id}`, { config: { expression: "{FB} + 1" } });
  assert.equal(cyc.status, 422, JSON.stringify(cyc.body));
  assert.match(JSON.stringify(cyc.body), /cycl|circular/i);
  // renaming a referenced field keeps the formula working and shows the new name
  ok(await api("PATCH", `${T(s.tasks)}/fields/${s.hours.id}`, { name: "Effort" }), 200, "rename");
  const fa = (await tableFields(s.tasks)).find((x) => x.id === a.id);
  assert.equal(fa.config.expression, "{Effort} + 1");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [s.hours.id]: 2 } }), 200, "edit");
  assert.equal((await getRecord(s.tasks, s.t[0])).fields[b.id], 30);
  // common functions
  const fx = await addField(s.tasks, {
    name: "Fx",
    type: "formula",
    config: {
      expression:
        'IF(AND({Effort} > 1, NOT(BLANK())), CONCATENATE(UPPER("ok"), "-", DATETIME_FORMAT(DATEADD("2026-01-31", 1, "months"), "YYYY-MM-DD")), "no")',
    },
  });
  assert.equal((await getRecord(s.tasks, s.t[0])).fields[fx.id], "OK-2026-02-28");
});

test("field ops: type conversion, duplicate, reorder, primary, delete", async () => {
  const words = s.f.Words;
  const ids = s.t;
  const vals = ["42", "High", "42"];
  for (const [i, id] of ids.entries()) {
    ok(await api("PATCH", `${T(s.tasks)}/records/${id}`, { fields: { [words.id]: vals[i] } }), 200, "words");
  }
  // text -> single_select creates options from distinct values
  const sel = ok(await api("PATCH", `${T(s.tasks)}/fields/${words.id}`, { type: "single_select" }), 200, "to select").field;
  assert.deepEqual(sel.config.options.map((o: any) => o.label).sort(), ["42", "High"]);
  const r0 = await getRecord(s.tasks, ids[0]);
  assert.equal(r0.fields[words.id], sel.config.options.find((o: any) => o.label === "42").id);
  // select -> text -> number
  ok(await api("PATCH", `${T(s.tasks)}/fields/${words.id}`, { type: "text" }), 200, "to text");
  assert.equal((await getRecord(s.tasks, ids[1])).fields[words.id], "High");
  ok(await api("PATCH", `${T(s.tasks)}/fields/${words.id}`, { type: "number" }), 200, "to number");
  assert.equal((await getRecord(s.tasks, ids[0])).fields[words.id], 42);
  assert.equal((await getRecord(s.tasks, ids[1])).fields[words.id], undefined);
  // number -> checkbox
  ok(await api("PATCH", `${T(s.tasks)}/fields/${words.id}`, { type: "checkbox" }), 200, "to checkbox");
  assert.equal((await getRecord(s.tasks, ids[0])).fields[words.id], true);
  // text -> date
  const dt = await addField(s.tasks, { name: "DateText", type: "text" });
  ok(await api("PATCH", `${T(s.tasks)}/records/${ids[0]}`, { fields: { [dt.id]: "2026-05-06" } }), 200, "dt");
  ok(await api("PATCH", `${T(s.tasks)}/fields/${dt.id}`, { type: "date" }), 200, "to date");
  assert.equal((await getRecord(s.tasks, ids[0])).fields[dt.id], "2026-05-06");
  // number field used by a rollup: change to text keeps dependents consistent (rollup of text = 0 numbers)
  // duplicate with values
  const dup = ok(await api("POST", `${T(s.tasks)}/fields/${s.f.Num.id}/duplicate`, { withValues: true }), 201, "dup").field;
  assert.equal(dup.name, "Num copy");
  const rr = await getRecord(s.tasks, s.r1);
  assert.equal(rr.fields[dup.id], rr.fields[s.f.Num.id]);
  // reorder + primary
  const all = await tableFields(s.tasks);
  const order = [all[1].id, all[0].id, ...all.slice(2).map((f) => f.id)];
  ok(await api("POST", `${T(s.tasks)}/fields/reorder`, { fieldIds: order }), 204, "reorder");
  const after = await tableFields(s.tasks);
  assert.equal(after[0].id, order[0]);
  ok(await api("POST", `${T(s.tasks)}/primary-field`, { fieldId: s.f.Mail.id }), 200, "set primary");
  ok(await api("DELETE", `${T(s.tasks)}/fields/${s.f.Mail.id}`), 409, "delete primary");
  ok(await api("POST", `${T(s.tasks)}/primary-field`, { fieldId: s.tName }), 200, "restore primary");
  ok(await api("PATCH", `${T(s.tasks)}/fields/${dup.id}`, { name: "Num" }), 409, "rename conflict");
  ok(await api("DELETE", `${T(s.tasks)}/fields/${dup.id}`), 204, "delete field");
  ok(await api("DELETE", `${T(s.tasks)}/fields/${dup.id}`), 404, "delete missing field");
  // deleting a field a formula uses turns the formula into an error, not a 500
  const h2 = await addField(s.tasks, { name: "H2", type: "number" });
  const f2 = await addField(s.tasks, { name: "F2", type: "formula", config: { expression: "{H2} + 1" } });
  ok(await api("DELETE", `${T(s.tasks)}/fields/${h2.id}`), 204, "delete referenced");
  const rec = await getRecord(s.tasks, ids[0]);
  assert.ok(rec.errors?.[f2.id] || rec.fields[f2.id] === undefined);
});

test("tables: duplicate with records, delete cleans up links", async () => {
  const dup = ok(await api("POST", `${T(s.projects)}/duplicate`, { withRecords: true }), 201, "dup table").table;
  assert.notEqual(dup.id, s.projects);
  assert.equal(dup.recordCount, 3);
  const dq = ok(await api("POST", `${T(dup.id)}/records/query`, {}), 200, "dup records").records;
  assert.equal(dq.length, 3);
  const totalCopy = dup.fields.find((f: any) => f.name === "Total");
  assert.ok(totalCopy, "computed field copied");
  ok(await api("POST", `/v1/bases/${s.baseId}/tables/reorder`, { tableIds: [dup.id, s.tasks, s.projects] }), 204, "reorder tables");
  const detail = ok(await api("GET", `/v1/bases/${s.baseId}`), 200, "base");
  assert.equal(detail.tables[0].id, dup.id);
  // delete Projects: the Task link field (and lookups through it) must go away
  ok(await api("DELETE", T(s.projects)), 204, "delete table");
  const tf = await tableFields(s.tasks);
  assert.ok(!tf.some((f) => f.id === s.link.id), "link field removed");
  const rec = await getRecord(s.tasks, s.t[0]);
  assert.equal(rec.fields[s.link.id], undefined);
  ok(await api("DELETE", T(dup.id)), 204, "delete dup");
});

test("large fan-out is deferred to the compute worker and drained", { timeout: 180_000 }, async () => {
  // 2,100 records exceed the free plan; put the test org on the team plan.
  const pool = new pg.Pool({ connectionString: DB_URL, max: 1 });
  try {
    await pool.query(
      `INSERT INTO core.subscriptions (org_id, plan_id, status)
       SELECT bd.org_id, p.id, 'active' FROM core.base_directory bd, core.plans p
       WHERE bd.base_id = $1 AND p.code = 'team'`,
      [decodePublicId(s.baseId, "bas").uuid],
    );
  } finally {
    await pool.end();
  }
  const hub = ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "Hub" }), 201, "hub").table;
  const spokes = ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "Spokes" }), 201, "spokes").table;
  const hubName = hub.fields.find((f: any) => f.isPrimary).id;
  const hubRec = ok(await api("POST", `${T(hub.id)}/records/query`, {}), 200, "hub recs").records[0].id;
  ok(await api("PATCH", `${T(hub.id)}/records/${hubRec}`, { fields: { [hubName]: "Before" } }), 200, "hub name");
  const lk = await addField(spokes.id, { name: "Hub", type: "link", config: { linkedTableId: hub.id } });
  for (let i = 0; i < 5; i++) {
    const recs = Array.from({ length: 420 }, () => ({ fields: { [lk.id]: [hubRec] } }));
    ok(await api("POST", `${T(spokes.id)}/records/batch`, { records: recs }), 201, "spokes batch");
  }
  const look = await addField(spokes.id, { name: "Hub name", type: "lookup", config: { linkFieldId: lk.id, targetFieldId: hubName } });
  const filterNew = { kind: "condition", fieldId: look.id, op: "contains", value: "After" };
  const count = async (filter: unknown) =>
    ok(await api("POST", `${T(spokes.id)}/records/query`, { filter, pageSize: 1, includeTotalCount: true }), 200, "count").totalCount;
  assert.equal(await count({ kind: "condition", fieldId: look.id, op: "contains", value: "Before" }), 2100);
  ok(await api("PATCH", `${T(hub.id)}/records/${hubRec}`, { fields: { [hubName]: "After" } }), 200, "rename hub");
  let n = 0;
  for (let i = 0; i < 120 && n < 2100; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    n = await count(filterNew);
  }
  assert.equal(n, 2100, "worker recomputed every deferred lookup");
  ok(await api("DELETE", T(spokes.id)), 204, "cleanup");
  ok(await api("DELETE", T(hub.id)), 204, "cleanup");
});

test("link field delete removes inverse; allowMultiple=false is enforced", async () => {
  const other = ok(await api("POST", `/v1/bases/${s.baseId}/tables`, { name: "People" }), 201, "people").table;
  const lk = await addField(s.tasks, { name: "Lead", type: "link", config: { linkedTableId: other.id, allowMultiple: false } });
  const ppl = ok(await api("POST", `${T(other.id)}/records/query`, {}), 200, "ppl").records;
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [lk.id]: [ppl[0].id, ppl[1].id] } }), 422, "single link");
  ok(await api("PATCH", `${T(s.tasks)}/records/${s.t[0]}`, { fields: { [lk.id]: [ppl[0].id] } }), 200, "one link");
  ok(await api("DELETE", `${T(s.tasks)}/fields/${lk.id}`), 204, "delete link");
  const of = await tableFields(other.id);
  assert.ok(!of.some((f) => f.id === lk.config.inverseFieldId), "inverse removed");
});
