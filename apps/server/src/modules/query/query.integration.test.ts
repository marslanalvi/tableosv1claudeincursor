/**
 * Integration tests for the record read path (workstream A):
 *  - SQL filter compiler vs in-memory evaluator parity, every field type × operator
 *  - typed multi-level sorting + keyset pagination (no skipped / duplicated rows)
 *  - search, projection, totalCount, view filters/sorts, group query, error mapping
 *
 * Run (API + DB must be up):
 *   cd apps/server && node --import tsx --test src/modules/query/query.integration.test.ts
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateFilter, operatorsForFieldType, type EvalField, type FilterAst, type FilterOp } from "@tabula/filter";
import { createFixture, OPTS, pidOf, rng, TAGS, type Fixture } from "./query-fixture.js";
import { idVariants } from "./context.js";

let fx: Fixture;
let all: any[] = [];
let evalFields: EvalField[] = [];
const q = (body: unknown) => fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/query`, body);

async function queryAll(body: Record<string, unknown>, pageSize = 500): Promise<any[]> {
  const out: any[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 1000; i++) {
    const res = await q({ ...body, pageSize, ...(cursor ? { cursor } : {}) });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    out.push(...res.body.records);
    cursor = res.body.nextCursor;
    if (!cursor) break;
  }
  return out;
}

before(async () => {
  fx = await createFixture(80, 7);
  all = await queryAll({});
  evalFields = Object.values(fx.fields).map((f) => ({
    id: f.id,
    type: f.type,
    config: f.config,
    aliases: [f.uuid],
    ...(f.lookupTarget ? { lookupTarget: f.lookupTarget } : {}),
  }));
});

after(async () => {
  await fx?.pool.end();
});

function operandsFor(key: string, type: string, op: FilterOp): unknown[] {
  if (op === "empty" || op === "notEmpty" || op === "isMe") return [undefined];
  const peer = fx.peerRecordUuids.map((u) => pidOf("rec", u));
  switch (type) {
    case "text":
    case "long_text":
    case "email":
    case "barcode":
      return ["alpha", "BETA", "gamma ray 2", "", "x", "user1@example.com", "abc"];
    case "number":
    case "currency":
    case "percent":
    case "rating":
    case "duration":
    case "autonumber":
      return [0, 2, "2.5", 7, 100, -3, 12.5, 0.25, 3600];
    case "checkbox":
      return [true, false];
    case "date":
    case "datetime":
    case "created_time":
    case "modified_time":
      if (op === "isWithin")
        return [
          { range: "pastWeek" },
          { range: "pastMonth" },
          { range: "nextWeek" },
          { range: "nextMonth" },
          { range: "thisWeek" },
          { range: "thisMonth" },
          { range: "pastYear" },
          { range: "nextYear" },
          { range: "pastNDays", n: 3 },
          { range: "nextNDays", n: 10 },
        ];
      return [
        { relative: "today" },
        { relative: "tomorrow" },
        { relative: "yesterday" },
        { relative: "oneWeekAgo" },
        { relative: "oneWeekFromNow" },
        { relative: "oneMonthAgo" },
        { relative: "oneMonthFromNow" },
        { relative: "exactDate", date: "2024-03-09" },
        "2020-02-29",
        "2024-01-05",
      ];
    case "single_select":
      return op === "eq" || op === "neq" ? ["opt_a", "opt_b", "Gamma"] : [["opt_a", "opt_b"], ["opt_c"]];
    case "multi_select":
      return [["opt_x"], ["opt_x", "opt_y"], ["opt_z"], ["Zulu"]];
    case "collaborator":
    case "created_by":
    case "modified_by": {
      const u = [fx.userId, pidOf("usr", fx.otherUserUuid)];
      return type === "collaborator" ? [[u[0]], [u[1]], u] : op === "eq" || op === "neq" ? u : [[u[0]], u];
    }
    case "link":
      if (op === "contains" || op === "notContains") return ["app", "AN", "zzz"];
      return [[peer[0]], [peer[0], peer[1]], [peer[3]]];
    case "lookup":
      switch (key) {
        case "lstatus":
          return ["zebra", "Mango", "opt_p1", "mango, zebra", "opt_gone"];
        case "lowner":
          return ["ada", "Bob Other", "bob other, ada tester", "usr_", "ws-a"];
        case "lfiles":
          return ["a.png", "PDF", "b.pdf, a.png"];
        case "lmain":
          return ["alpha", "Beta", "gamma ray", "0"];
        default:
          return ["apple", "date", "an"];
      }
    case "formula":
      if (key === "fnum") return [3, 4.5, 8, -1];
      return op === "gt" || op === "gte" || op === "lt" || op === "lte" ? [7, 40] : ["hello", "world", "42", "true"];
    default:
      return [];
  }
}

describe("filter: SQL ↔ evaluator parity", () => {
  it("every field type × operator × operand agrees", async () => {
    let checked = 0;
    const failures: string[] = [];
    for (const [key, f] of Object.entries(fx.fields)) {
      for (const op of operatorsForFieldType(f.type, f.config)) {
        for (const value of operandsFor(key, f.type, op)) {
          const filter: FilterAst = { kind: "condition", fieldId: f.id, op, ...(value !== undefined ? { value } : {}) };
          const res = await q({ filter, pageSize: 500 });
          if (res.status !== 200) {
            failures.push(`${key} ${op} ${JSON.stringify(value)} → HTTP ${res.status} ${JSON.stringify(res.body)}`);
            continue;
          }
          const sqlIds = new Set(res.body.records.map((r: any) => r.id));
          const ctx = { currentUserId: fx.userId, timeZone: "UTC", idVariants };
          const evalIds = new Set(all.filter((r) => evaluateFilter(filter, r, evalFields, ctx)).map((r) => r.id));
          const onlySql = [...sqlIds].filter((x) => !evalIds.has(x));
          const onlyEval = [...evalIds].filter((x) => !sqlIds.has(x));
          if (onlySql.length || onlyEval.length) {
            const sample = all.find((r) => r.id === (onlySql[0] ?? onlyEval[0]));
            failures.push(
              `${key}(${f.type}) ${op} ${JSON.stringify(value)}: sql-only=${onlySql.length} eval-only=${onlyEval.length} sample=${JSON.stringify(sample?.fields[f.id])}`,
            );
          }
          checked++;
        }
      }
    }
    assert.ok(checked > 200, `checked ${checked}`);
    assert.deepEqual(failures, []);
  });

  it("random nested and/or trees agree", async () => {
    const r = rng(99);
    const leaves: FilterAst[] = [
      { kind: "condition", fieldId: fx.fields["num"]!.id, op: "gt", value: 2 },
      { kind: "condition", fieldId: fx.fields["status"]!.id, op: "anyOf", value: ["opt_a"] },
      { kind: "condition", fieldId: fx.fields["tags"]!.id, op: "hasAnyOf", value: ["opt_x"] },
      { kind: "condition", fieldId: fx.fields["done"]!.id, op: "eq", value: true },
      { kind: "condition", fieldId: fx.fields["name"]!.id, op: "contains", value: "a" },
      { kind: "condition", fieldId: fx.fields["day"]!.id, op: "isWithin", value: { range: "pastMonth" } },
      { kind: "condition", fieldId: fx.fields["link"]!.id, op: "notEmpty" },
      { kind: "condition", fieldId: fx.fields["owner"]!.id, op: "isMe" },
      { kind: "condition", fieldId: fx.fields["num"]!.id, op: "eq" }, // incomplete → dropped
    ];
    const tree = (d: number): FilterAst =>
      d === 0 || r() < 0.3
        ? leaves[Math.floor(r() * leaves.length)]!
        : { kind: r() < 0.5 ? "and" : "or", children: [tree(d - 1), tree(d - 1), ...(r() < 0.5 ? [tree(d - 1)] : [])] };
    for (let i = 0; i < 25; i++) {
      const filter = tree(3);
      const res = await q({ filter, pageSize: 500 });
      assert.equal(res.status, 200);
      const ctx = { currentUserId: fx.userId, timeZone: "UTC", idVariants };
      const expect = all.filter((x) => evaluateFilter(filter, x, evalFields, ctx)).map((x) => x.id).sort();
      assert.deepEqual(res.body.records.map((x: any) => x.id).sort(), expect, JSON.stringify(filter));
    }
  });
});

describe("sorting + keyset pagination", () => {
  const sortCases: [string, "asc" | "desc"][][] = [
    [["num", "asc"]],
    [["num", "desc"]],
    [["price", "desc"]],
    [["day", "asc"]],
    [["when", "desc"]],
    [["status", "asc"]],
    [["status", "desc"], ["num", "asc"]],
    [["tags", "asc"]],
    [["done", "desc"], ["name", "asc"]],
    [["owner", "asc"]],
    [["link", "asc"]],
    [["files", "desc"]],
    [["fnum", "asc"]],
    [["ftext", "asc"]],
    [["ctime", "desc"]],
    [["mtime", "asc"]],
    [["cby", "asc"], ["auto", "desc"]],
    [["auto", "desc"]],
    [["name", "asc"], ["num", "desc"], ["day", "asc"]],
    [["look", "asc"]],
    [["lstatus", "asc"]],
    [["lowner", "desc"]],
    [["lfiles", "asc"]],
    [["lmain", "asc"], ["num", "desc"]],
  ];
  for (const sc of sortCases) {
    it(`pages through ${sc.map(([k, d]) => `${k} ${d}`).join(", ")} without gaps or duplicates`, async () => {
      const sort = sc.map(([k, d]) => ({ field: fx.fields[k]!.id, direction: d }));
      const full = await queryAll({ sort }, 500);
      for (const ps of [1, 3, 7]) {
        const paged = await queryAll({ sort }, ps);
        assert.deepEqual(paged.map((r) => r.id), full.map((r) => r.id), `pageSize ${ps}`);
      }
      assert.equal(new Set(full.map((r) => r.id)).size, all.length);
    });
  }

  it("orders typed values correctly", async () => {
    const numId = fx.fields["num"]!.id;
    const asc = await queryAll({ sort: [{ field: numId, direction: "asc" }] });
    const nums = asc.map((r) => r.fields[numId]).filter((v) => typeof v === "number");
    assert.deepEqual(nums, [...nums].sort((a, b) => a - b), "numbers numeric asc");
    // empties last in both directions
    const firstEmpty = asc.findIndex((r) => typeof r.fields[numId] !== "number");
    assert.ok(asc.slice(firstEmpty).every((r) => typeof r.fields[numId] !== "number"), "nulls last asc");
    const desc = await queryAll({ sort: [{ field: numId, direction: "desc" }] });
    const dn = desc.map((r) => r.fields[numId]).filter((v) => typeof v === "number");
    assert.deepEqual(dn, [...dn].sort((a, b) => b - a), "numbers numeric desc");
    const fe = desc.findIndex((r) => typeof r.fields[numId] !== "number");
    assert.ok(desc.slice(fe).every((r) => typeof r.fields[numId] !== "number"), "nulls last desc");

    const stId = fx.fields["status"]!.id;
    const bySel = await queryAll({ sort: [{ field: stId, direction: "asc" }] });
    const order = OPTS.map((o) => o.id);
    const pos = bySel.map((r) => r.fields[stId]).filter(Boolean).map((v: string) => order.indexOf(v));
    assert.deepEqual(pos, [...pos].sort((a, b) => a - b), "select by option order");

    const dayId = fx.fields["day"]!.id;
    const byDay = await queryAll({ sort: [{ field: dayId, direction: "asc" }] });
    const days = byDay.map((r) => r.fields[dayId]).filter(Boolean);
    assert.deepEqual(days, [...days].sort(), "dates chronological");
    void TAGS;
  });
});

describe("search / projection / count / views / single record", () => {
  it("search matches text and select labels case-insensitively", async () => {
    const res = await q({ search: "GAMMA", pageSize: 500 });
    assert.equal(res.status, 200);
    const stId = fx.fields["status"]!.id;
    const notesId = fx.fields["notes"]!.id;
    const nameId = fx.fields["name"]!.id;
    const lmainId = fx.fields["lmain"]!.id;
    const hit = (r: any) =>
      r.fields[stId] === "opt_c" ||
      String(r.fields[notesId] ?? "").toLowerCase().includes("gamma") ||
      String(r.fields[nameId] ?? "").toLowerCase().includes("gamma") ||
      (r.fields[lmainId] ?? []).some((l: any) => l.name.toLowerCase().includes("gamma"));
    for (const r of res.body.records) assert.ok(hit(r), JSON.stringify(r.fields));
    assert.equal(res.body.records.length, all.filter(hit).length);
  });

  it("projection, totalCount and pagination metadata", async () => {
    const numId = fx.fields["num"]!.id;
    const res = await q({ fields: [numId], pageSize: 10 });
    assert.equal(res.status, 200);
    assert.equal(res.body.totalCount, all.length);
    assert.ok(res.body.nextCursor);
    for (const r of res.body.records) assert.ok(Object.keys(r.fields).every((k) => k === numId));
    const filtered = await q({ filter: { kind: "condition", fieldId: numId, op: "notEmpty" }, pageSize: 5 });
    assert.equal(filtered.body.totalCount, all.filter((r) => typeof r.fields[numId] === "number").length);
  });

  it("viewId applies the saved filter and sorts", async () => {
    const numId = fx.fields["num"]!.id;
    const viewUuid = (await fx.pool.query(`SELECT id FROM data.views WHERE table_id = $1 AND deleted_at IS NULL LIMIT 1`, [fx.tableUuid])).rows[0]?.id;
    assert.ok(viewUuid, "default view exists");
    await fx.pool.query(`UPDATE data.views SET config = config || $2::jsonb WHERE id = $1`, [
      viewUuid,
      JSON.stringify({
        filter: { kind: "condition", fieldId: numId, op: "gte", value: 2 },
        sorts: [{ fieldId: numId, direction: "desc" }],
        hiddenFieldIds: [],
      }),
    ]);
    const viewId = pidOf("viw" as any, viewUuid);
    const res = await q({ viewId, pageSize: 500 });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const vals = res.body.records.map((r: any) => r.fields[numId]);
    assert.ok(vals.every((v: number) => v >= 2));
    assert.deepEqual(vals, [...vals].sort((a: number, b: number) => b - a));
    // extra request filter is ANDed
    const res2 = await q({ viewId, filter: { kind: "condition", fieldId: numId, op: "lt", value: 10 }, pageSize: 500 });
    assert.ok(res2.body.records.every((r: any) => r.fields[numId] >= 2 && r.fields[numId] < 10));
    // explicit sort overrides
    const res3 = await q({ viewId, sort: [{ field: numId, direction: "asc" }], pageSize: 500 });
    const v3 = res3.body.records.map((r: any) => r.fields[numId]);
    assert.deepEqual(v3, [...v3].sort((a: number, b: number) => a - b));
  });

  it("GET single record matches query output", async () => {
    const one = all[3];
    const res = await fx.api("GET", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/${one.id}`);
    assert.equal(res.status, 200);
    const strip = (r: any) => JSON.parse(JSON.stringify(r, (k, v) => (k === "url" || k === "thumbnailUrl" ? undefined : v)));
    assert.deepEqual(strip(res.body.record), strip(one));
    const missing = await fx.api("GET", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/${pidOf("rec", "01900000-0000-7000-8000-000000000000")}`);
    assert.equal(missing.status, 404);
    const bad = await fx.api("GET", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/rec_nope`);
    assert.equal(bad.status, 422);
  });

  it("serializes every value shape per CONTRACTS §3", () => {
    const F = (k: string) => fx.fields[k]!.id;
    for (const r of all) {
      assert.match(r.id, /^rec_/);
      assert.equal(typeof r.version, "number");
      assert.ok(r.updatedAt && r.createdAt);
      for (const v of Object.values(r.fields)) assert.ok(v !== null && v !== "" && !(Array.isArray(v) && v.length === 0));
      const f = r.fields;
      if (F("num") in f) assert.equal(typeof f[F("num")], "number");
      if (F("price") in f) assert.equal(typeof f[F("price")], "number");
      if (F("done") in f) assert.equal(f[F("done")], true);
      if (F("day") in f) assert.match(f[F("day")], /^\d{4}-\d{2}-\d{2}$/);
      if (F("when") in f) assert.match(f[F("when")], /Z$/);
      if (F("status") in f) assert.match(f[F("status")], /^opt_/);
      if (F("tags") in f) for (const t of f[F("tags")]) assert.match(t, /^opt_/);
      if (F("owner") in f) for (const u of f[F("owner")]) assert.ok(u.id.startsWith("usr_") && u.name && u.email);
      if (F("files") in f) for (const a of f[F("files")]) assert.ok(a.id.startsWith("att_") && a.filename && a.url && typeof a.size === "number");
      if (F("link") in f) for (const l of f[F("link")]) assert.ok(l.id.startsWith("rec_") && typeof l.name === "string");
      if (F("code") in f) assert.equal(typeof f[F("code")].text, "string");
      if (F("fnum") in f) assert.equal(typeof f[F("fnum")], "number");
      assert.equal(f[F("auto")], r.rowNumber);
      assert.equal(f[F("ctime")], r.createdAt);
      assert.ok(f[F("cby")].id.startsWith("usr_"));
      assert.ok(f[F("mby")].id.startsWith("usr_"));
      if (r.errors) for (const [k, v] of Object.entries(r.errors)) {
        assert.equal(k, F("fnum"));
        assert.match(String(v), /^#ERROR/);
        assert.ok(!(F("fnum") in f));
      }
    }
    assert.ok(all.some((r) => r.errors), "some formula errors surfaced");
  });
});

describe("lookups use the target's display text", () => {
  const ids = (res: any) => res.body.records.map((r: any) => r.id).sort();
  const cond = (k: string, op: string, value?: unknown) => ({ kind: "condition", fieldId: fx.fields[k]!.id, op, ...(value !== undefined ? { value } : {}) });

  it("filters by label / name / filename, not stored ids", async () => {
    const cases: [string, string, (v: any[]) => boolean][] = [
      ["lstatus", "zebra", (v) => v.includes("opt_p1")],
      ["lowner", "bob", (v) => v.some((u) => u.name === "Bob Other")],
      ["lfiles", "pdf", (v) => v.some((a) => a.filename === "b.pdf")],
      ["lmain", "gamma", (v) => v.some((l) => l.name.toLowerCase().includes("gamma"))],
    ];
    for (const [k, text, has] of cases) {
      const fid = fx.fields[k]!.id;
      const res = await q({ filter: cond(k, "contains", text), pageSize: 500 });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const expect = all.filter((r) => has(r.fields[fid] ?? [])).map((r) => r.id).sort();
      assert.ok(expect.length > 0, `${k} fixture has matches`);
      assert.deepEqual(ids(res), expect, k);
    }
    // stored ids never match text ops
    for (const [k, raw] of [["lstatus", "opt_p"], ["lowner", fx.userUuid.slice(0, 8)], ["lmain", fx.recordUuids[0]!.slice(0, 8)]] as const) {
      const res = await q({ filter: cond(k, "contains", raw), pageSize: 500 });
      assert.equal(res.body.records.length, 0, `${k} contains ${raw}`);
    }
  });

  it("dangling ids are empty, like the serialized value", async () => {
    for (const k of ["lowner", "lfiles", "lmain"]) {
      const fid = fx.fields[k]!.id;
      const res = await q({ filter: cond(k, "empty"), pageSize: 500 });
      assert.deepEqual(ids(res), all.filter((r) => !(fid in r.fields)).map((r) => r.id).sort(), k);
    }
  });

  it("search matches lookup display text", async () => {
    const res = await q({ search: "MANGO", pageSize: 500 });
    const fid = fx.fields["lstatus"]!.id;
    assert.deepEqual(ids(res), all.filter((r) => (r.fields[fid] ?? []).includes("opt_p2")).map((r) => r.id).sort());
  });

  it("sorts lookups and collaborators by display text / option order", async () => {
    for (const k of ["owner", "lowner"]) {
      const fid = fx.fields[k]!.id;
      for (const dir of ["asc", "desc"] as const) {
        const rows = await queryAll({ sort: [{ field: fid, direction: dir }] });
        const names = rows.map((r) => r.fields[fid]?.[0]?.name?.toLowerCase() ?? null);
        const filled = names.filter((n): n is string => n !== null);
        const sorted = [...filled].sort();
        assert.deepEqual(filled, dir === "asc" ? sorted : sorted.reverse(), `${k} ${dir}`);
        assert.ok(names.slice(filled.length).every((n) => n === null), `${k} ${dir} empties last`);
        assert.ok(new Set(filled).size > 1, `${k} has distinct names`);
      }
    }
    const sid = fx.fields["lstatus"]!.id;
    const rows = await queryAll({ sort: [{ field: sid, direction: "asc" }] });
    const pos = rows.map((r) => ["opt_p1", "opt_p2"].indexOf(r.fields[sid]?.[0])).filter((x) => x >= 0);
    assert.deepEqual(pos, [...pos].sort((a, b) => a - b));
  });

  it("groups lookups by display text", async () => {
    const res = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
      groupBy: [{ fieldId: fx.fields["lowner"]!.id }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const values = res.body.groups.map((g: any) => g.value);
    assert.ok(values.includes("Ada Tester") && values.includes("Bob Other, Ada Tester"), JSON.stringify(values));
    assert.equal(res.body.groups.reduce((s: number, g: any) => s + g.count, 0), all.length);
  });
});

describe("group query", () => {
  it("groups by select with aggregates; counts add up", async () => {
    const stId = fx.fields["status"]!.id;
    const numId = fx.fields["num"]!.id;
    const res = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
      groupBy: [{ fieldId: stId }],
      aggregates: [
        { op: "count" },
        { op: "sum", fieldId: numId },
        { op: "avg", fieldId: numId },
        { op: "min", fieldId: numId },
        { op: "max", fieldId: numId },
        { op: "filled", fieldId: numId },
        { op: "empty", fieldId: numId },
        { op: "unique", fieldId: numId },
      ],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const groups = res.body.groups as any[];
    assert.equal(groups.reduce((s, g) => s + g.count, 0), all.length);
    assert.deepEqual(groups.map((g) => g.value), ["opt_a", "opt_b", "opt_c", null].filter((v) => groups.some((g) => g.value === v)));
    for (const g of groups) {
      const members = all.filter((r) => (r.fields[stId] ?? null) === g.value);
      assert.equal(g.count, members.length);
      const nums = members.map((r) => r.fields[numId]).filter((v) => typeof v === "number");
      assert.equal(g.aggregates[`filled:${numId}`], nums.length);
      assert.equal(g.aggregates[`empty:${numId}`], members.length - nums.length);
      assert.equal(g.aggregates[`unique:${numId}`], new Set(nums).size);
      if (nums.length) {
        assert.ok(Math.abs(g.aggregates[`sum:${numId}`] - nums.reduce((a, b) => a + b, 0)) < 1e-9);
        assert.equal(g.aggregates[`min:${numId}`], Math.min(...nums));
        assert.equal(g.aggregates[`max:${numId}`], Math.max(...nums));
      }
    }
  });

  it("multi-level, collaborator/link groups and summary (no groupBy)", async () => {
    const res = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
      groupBy: [{ fieldId: fx.fields["done"]!.id }, { fieldId: fx.fields["owner"]!.id }],
      aggregates: [{ op: "count" }],
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.groups.reduce((s: number, g: any) => s + g.count, 0), all.length);
    const link = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
      groupBy: [{ fieldId: fx.fields["link"]!.id }],
    });
    assert.equal(link.status, 200, JSON.stringify(link.body));
    for (const g of link.body.groups) if (g.value) for (const l of g.value) assert.ok(l.id.startsWith("rec_") && "name" in l);
    const summary = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
      aggregates: [{ op: "count" }, { op: "max", fieldId: fx.fields["day"]!.id }],
    });
    assert.equal(summary.status, 200);
    assert.equal(summary.body.groups.length, 1);
    assert.equal(summary.body.groups[0].count, all.length);
  });

  // Regression: `unique` on select/link/lookup fields left sort-key parameters
  // unreferenced → Postgres "could not determine data type of parameter $2" → 500.
  it("every aggregate × field type × groupBy is 200 or 422, never 5xx", async () => {
    const g = (body: unknown) => fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, body);
    const ops = ["count", "sum", "avg", "min", "max", "filled", "empty", "unique"];
    const failures: string[] = [];
    for (const groupBy of [undefined, [{ fieldId: fx.fields["status"]!.id }]]) {
      for (const op of ops) {
        for (const k of [null, ...Object.keys(fx.fields)]) {
          const body = { ...(groupBy ? { groupBy } : {}), aggregates: [{ op, ...(k ? { fieldId: fx.fields[k]!.id } : {}) }] };
          const res = await g(body);
          if (res.status !== 200 && res.status !== 422) failures.push(`${op}:${k} group=${!!groupBy} → ${res.status} ${res.body?.detail}`);
          if (res.status === 422) assert.equal(typeof res.body.detail, "string");
        }
      }
    }
    assert.deepEqual(failures, []);
  });

  it("unique counts distinct values for select / multi-select / link / lookup fields", async () => {
    const keys = ["status", "tags", "link", "lstatus", "lowner", "lmain", "owner"];
    const res = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
      aggregates: keys.map((k) => ({ op: "unique", fieldId: fx.fields[k]!.id })),
    });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const agg = res.body.groups[0].aggregates;
    // status: legacy label "Beta" groups with opt_b, which the wire value already reflects.
    const fid = fx.fields["status"]!.id;
    assert.equal(agg[`unique:${fid}`], new Set(all.map((r) => r.fields[fid]).filter(Boolean)).size);
    const tid = fx.fields["tags"]!.id;
    assert.equal(agg[`unique:${tid}`], new Set(all.map((r) => r.fields[tid]).filter(Boolean).map((v) => JSON.stringify(v))).size);
    for (const k of keys) assert.equal(typeof agg[`unique:${fx.fields[k]!.id}`], "number", k);
  });

  it("multi-level groupBy with filter, search and viewId", async () => {
    const viewUuid = (await fx.pool.query(`SELECT id FROM data.views WHERE table_id = $1 AND deleted_at IS NULL LIMIT 1`, [fx.tableUuid])).rows[0]?.id;
    const viewId = pidOf("viw" as any, viewUuid);
    const F = (k: string) => fx.fields[k]!.id;
    const levelSets = [
      ["status", "tags", "link"],
      ["lstatus", "owner", "day"],
      ["lmain", "done", "when"],
      ["cby", "fnum", "lowner"],
    ];
    const extras: Record<string, unknown>[] = [
      { filter: { kind: "condition", fieldId: F("num"), op: "gt", value: 1 } },
      { search: "alpha" },
      { search: "zebra", filter: { kind: "condition", fieldId: F("lowner"), op: "contains", value: "ada" } },
      { viewId },
      { viewId, search: "a", filter: { kind: "condition", fieldId: F("tags"), op: "hasAnyOf", value: ["opt_x"] } },
    ];
    for (const levels of levelSets) {
      for (const extra of extras) {
        const total = await q({ ...extra, pageSize: 1 });
        assert.equal(total.status, 200, JSON.stringify(total.body));
        const res = await fx.api("POST", `/v1/bases/${fx.baseId}/tables/${fx.tableId}/records/group`, {
          ...extra,
          groupBy: levels.map((k, i) => ({ fieldId: F(k), direction: i === 1 ? "desc" : "asc" })),
          aggregates: [{ op: "count" }, { op: "unique", fieldId: F(levels[0]!) }, { op: "sum", fieldId: F("num") }, { op: "max", fieldId: F("day") }],
        });
        assert.equal(res.status, 200, `${levels} ${JSON.stringify(extra)} ${JSON.stringify(res.body)}`);
        assert.equal(res.body.groups.reduce((s: number, x: any) => s + x.count, 0), total.body.totalCount, `${levels} ${JSON.stringify(extra)}`);
        for (const x of res.body.groups) assert.equal(x.values.length, 3);
      }
    }
  });
});

describe("errors are 4xx problem+json", () => {
  const cases: [string, unknown][] = [
    ["unknown field", { filter: { kind: "condition", fieldId: "fld_doesnotexist", op: "eq", value: 1 } }],
    ["bad op", { filter: { kind: "condition", fieldId: "x", op: "bogus" } }],
    ["bad number", { filter: { kind: "condition", fieldId: "@num", op: "gt", value: "abc" } }],
    ["bad date", { filter: { kind: "condition", fieldId: "@day", op: "eq", value: "2024-13-45" } }],
    ["op not for type", { filter: { kind: "condition", fieldId: "@done", op: "contains", value: "x" } }],
    ["bad within", { filter: { kind: "condition", fieldId: "@day", op: "isWithin", value: { range: "never" } } }],
    ["bad cursor", { cursor: "garbage!!" }],
    ["unknown sort", { sort: [{ field: "fld_nope", direction: "asc" }] }],
    ["unknown projection", { fields: ["fld_nope"] }],
    ["bad view", { viewId: "viw_nope" }],
  ];
  for (const [name, body] of cases) {
    it(name, async () => {
      const fixed = JSON.parse(JSON.stringify(body).replace(/"@(\w+)"/g, (_, k) => JSON.stringify(fx.fields[k]!.id)));
      const res = await q(fixed);
      assert.ok(res.status >= 400 && res.status < 500, `${res.status} ${JSON.stringify(res.body)}`);
      assert.equal(typeof res.body.detail, "string");
    });
  }
  it("cursor from a different sort is rejected", async () => {
    const numId = fx.fields["num"]!.id;
    const p1 = await q({ sort: [{ field: numId, direction: "asc" }], pageSize: 2 });
    const res = await q({ sort: [{ field: numId, direction: "desc" }], pageSize: 2, cursor: p1.body.nextCursor });
    assert.equal(res.status, 422);
  });
});
