import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  addMonths,
  compileFilterToSql,
  compileSearchToSql,
  evaluateFilter,
  FilterError,
  operatorLabel,
  operatorsForFieldType,
  parseIsoInstant,
  resolveDateOperand,
  resolveWithinRange,
  sortKeysFor,
  SqlParams,
  type EvalField,
  type FilterAst,
  type SqlFieldInfo,
} from "./index.js";

const now = new Date("2026-10-07T02:30:00Z"); // still Oct 6 in New York
const F = (id: string, slot: number, type: string, config: Record<string, unknown> = {}, isComputed = false): SqlFieldInfo => ({
  id,
  slot,
  type,
  config,
  isComputed,
});

describe("operators", () => {
  it("lists operators per type (snake_case and legacy names)", () => {
    assert.deepEqual(operatorsForFieldType("checkbox"), ["eq"]);
    assert.ok(operatorsForFieldType("number").includes("gt"));
    assert.ok(!operatorsForFieldType("text").includes("gt"));
    assert.ok(operatorsForFieldType("formula", {}).includes("gt"), "untyped formula gets numeric ops");
    assert.ok(!operatorsForFieldType("formula", { resultType: "text" }).includes("gt"));
    assert.ok(operatorsForFieldType("date").includes("isWithin"));
    assert.deepEqual(operatorsForFieldType("dateTime"), operatorsForFieldType("datetime"));
    assert.ok(operatorsForFieldType("collaborator").includes("isMe"));
    assert.deepEqual(operatorsForFieldType("attachment"), ["empty", "notEmpty"]);
    assert.deepEqual(operatorsForFieldType("button"), []);
    assert.ok(operatorsForFieldType("rollup", { aggregation: "and" }).includes("eq"));
  });
  it("labels operators", () => {
    assert.equal(operatorLabel("notContains"), "does not contain");
    assert.equal(operatorLabel("eq", "number"), "=");
    assert.equal(operatorLabel("eq", "multi_select"), "is exactly");
  });
});

describe("dates", () => {
  it("resolves relative dates in a time zone", () => {
    assert.equal(resolveDateOperand({ relative: "today" }, { now, timeZone: "UTC" }), "2026-10-07");
    assert.equal(resolveDateOperand({ relative: "today" }, { now, timeZone: "America/New_York" }), "2026-10-06");
    assert.equal(resolveDateOperand({ relative: "oneWeekAgo" }, { now, timeZone: "UTC" }), "2026-09-30");
    assert.equal(resolveDateOperand({ relative: "oneMonthFromNow" }, { now }), "2026-11-07");
    assert.equal(resolveDateOperand({ relative: "nDaysAgo", n: 3 }, { now }), "2026-10-04");
    assert.equal(resolveDateOperand({ relative: "exactDate", date: "2024-02-29" }, { now }), "2024-02-29");
    assert.equal(resolveDateOperand({ relative: "exactDate" }, { now }), null);
    assert.equal(resolveDateOperand("", { now }), null);
    assert.throws(() => resolveDateOperand("2024-13-01", { now }), FilterError);
    assert.equal(addMonths("2026-01-31", 1), "2026-02-28");
  });
  it("resolves isWithin ranges", () => {
    assert.deepEqual(resolveWithinRange({ range: "pastWeek" }, { now }), ["2026-09-30", "2026-10-07"]);
    assert.deepEqual(resolveWithinRange({ range: "thisWeek" }, { now }), ["2026-10-04", "2026-10-10"]);
    assert.deepEqual(resolveWithinRange({ range: "thisMonth" }, { now }), ["2026-10-01", "2026-10-31"]);
    assert.deepEqual(resolveWithinRange({ range: "nextNDays", n: 5 }, { now }), ["2026-10-07", "2026-10-12"]);
    assert.equal(resolveWithinRange({ range: "pastNDays" }, { now }), null);
    assert.throws(() => resolveWithinRange({ range: "nope" }, { now }), FilterError);
  });
  it("parses ISO instants strictly", () => {
    assert.equal(parseIsoInstant("2024-02-30T10:00:00Z"), null);
    assert.equal(parseIsoInstant("garbage"), null);
    assert.equal(parseIsoInstant("2024-02-29T10:00:00Z")?.toISOString(), "2024-02-29T10:00:00.000Z");
  });
});

const fields: EvalField[] = [
  { id: "fld_t", type: "text" },
  { id: "fld_n", type: "number" },
  { id: "fld_d", type: "date" },
  { id: "fld_dt", type: "datetime", config: { timeZone: "America/New_York" } },
  { id: "fld_c", type: "checkbox" },
  { id: "fld_s", type: "single_select", config: { options: [{ id: "opt_a", label: "A" }, { id: "opt_b", label: "B" }] } },
  { id: "fld_m", type: "multi_select", config: { options: [{ id: "opt_x", label: "X" }, { id: "opt_y", label: "Y" }] } },
  { id: "fld_u", type: "collaborator" },
  { id: "fld_by", type: "created_by" },
  { id: "fld_l", type: "link" },
  { id: "fld_att", type: "attachment" },
];
const rec = {
  fields: {
    fld_t: "Hello World",
    fld_n: 12.5,
    fld_d: "2026-10-01",
    fld_dt: "2026-10-07T02:00:00.000Z",
    fld_c: true,
    fld_s: "opt_a",
    fld_m: ["opt_x", "opt_y"],
    fld_u: [{ id: "usr_me", name: "Me", email: "me@x" }],
    fld_by: { id: "usr_other", name: "O", email: "o@x" },
    fld_l: [{ id: "rec_1", name: "Apple" }],
  },
};
const ctx = { now, timeZone: "UTC", currentUserId: "usr_me" };
const ev = (ast: FilterAst) => evaluateFilter(ast, rec, fields, ctx);
const c = (fieldId: string, op: string, value?: unknown): FilterAst =>
  ({ kind: "condition", fieldId, op, ...(value !== undefined ? { value } : {}) }) as FilterAst;

describe("evaluator", () => {
  it("text", () => {
    assert.equal(ev(c("fld_t", "contains", "WORLD")), true);
    assert.equal(ev(c("fld_t", "eq", "hello world")), true);
    assert.equal(ev(c("fld_t", "startsWith", "hel")), true);
    assert.equal(ev(c("fld_t", "endsWith", "xx")), false);
    assert.equal(ev(c("fld_t", "notContains", "zzz")), true);
  });
  it("number / checkbox / empty", () => {
    assert.equal(ev(c("fld_n", "gt", 12)), true);
    assert.equal(ev(c("fld_n", "lte", "12.5")), true);
    assert.equal(ev(c("fld_n", "neq", 1)), true);
    assert.equal(ev(c("fld_c", "eq", false)), false);
    assert.equal(ev(c("fld_att", "empty")), true);
    assert.throws(() => ev(c("fld_n", "gt", "abc")), FilterError);
  });
  it("dates (datetime uses field time zone)", () => {
    assert.equal(ev(c("fld_d", "isBefore", { relative: "today" })), true);
    assert.equal(ev(c("fld_d", "isWithin", { range: "pastWeek" })), true);
    assert.equal(ev(c("fld_dt", "eq", "2026-10-06")), true, "02:00Z is Oct 6 in New York");
  });
  it("selects, collaborators, links", () => {
    assert.equal(ev(c("fld_s", "eq", "opt_a")), true);
    assert.equal(ev(c("fld_s", "anyOf", ["B"])), false);
    assert.equal(ev(c("fld_s", "noneOf", ["opt_b"])), true);
    assert.equal(ev(c("fld_m", "hasAllOf", ["opt_x", "opt_y"])), true);
    assert.equal(ev(c("fld_m", "eq", ["opt_x"])), false);
    assert.equal(ev(c("fld_u", "isMe")), true);
    assert.equal(ev(c("fld_by", "isMe")), false);
    assert.equal(ev(c("fld_l", "contains", "app")), true);
    assert.equal(ev(c("fld_l", "hasAnyOf", ["rec_2"])), false);
  });
  it("lookups use display text (select labels mapped from ids)", () => {
    const lf: EvalField[] = [
      { id: "fld_ls", type: "lookup", lookupTarget: { id: "t1", type: "single_select", config: { options: [{ id: "opt_z", label: "Zed" }] } } },
      { id: "fld_lu", type: "lookup", lookupTarget: { id: "t2", type: "collaborator" } },
      { id: "fld_la", type: "lookup", lookupTarget: { id: "t3", type: "attachment" } },
      { id: "fld_ll", type: "lookup", lookupTarget: { id: "t4", type: "link" } },
      { id: "fld_lx", type: "lookup" },
    ];
    const r = {
      fields: {
        fld_ls: ["opt_z", "opt_unknown"],
        fld_lu: [{ id: "usr_1", name: "Zed Smith", email: "z@x" }],
        fld_la: [{ id: "att_1", filename: "zed.png" }],
        fld_ll: [{ id: "rec_1", name: "Zed Corp" }],
        fld_lx: ["opt_z"],
      },
    };
    const e = (ast: FilterAst) => evaluateFilter(ast, r, lf, ctx);
    assert.equal(e(c("fld_ls", "contains", "zed")), true);
    assert.equal(e(c("fld_ls", "eq", "zed, opt_unknown")), true);
    assert.equal(e(c("fld_ls", "contains", "opt_z")), false);
    for (const id of ["fld_lu", "fld_la", "fld_ll"]) assert.equal(e(c(id, "contains", "zed")), true, id);
    assert.equal(e(c("fld_lu", "contains", "usr_1")), false);
    assert.equal(e(c("fld_lx", "contains", "opt_z")), true, "no target: stored text");
  });
  it("groups drop incomplete conditions", () => {
    assert.equal(ev({ kind: "or", children: [c("fld_n", "gt"), c("fld_n", "lt", 0)] }), false);
    assert.equal(ev({ kind: "and", children: [c("fld_n", "gt")] }), true);
    assert.equal(evaluateFilter(null, rec, fields), true);
  });
  it("rejects unsupported operator for type", () => {
    assert.throws(() => ev(c("fld_c", "contains", "x")), FilterError);
    assert.throws(() => ev(c("fld_t", "bogus", "x")), /INVALID_FILTER_AST/);
  });
});

describe("SQL compiler", () => {
  const sqlFields = new Map<string, SqlFieldInfo>([
    ["n", F("n", 2, "number")],
    ["d", F("d", 3, "date")],
    ["c", F("c", 4, "checkbox")],
    ["f", F("f", 5, "formula", { resultType: "number" }, true)],
    ["auto", F("auto", 6, "autonumber")],
    ["t", F("t", 7, "text")],
  ]);
  it("uses safe typed expressions and shared params", () => {
    const p = new SqlParams(["table"]);
    const r = compileFilterToSql(c("n", "gt", 10), undefined, { fields: sqlFields, params: p });
    assert.match(r.sql, /jsonb_typeof\(r\.cells->'2'\) = 'number'/);
    assert.match(r.sql, /\$2::float8/);
    assert.deepEqual(r.params, ["table", 10]);
  });
  it("never casts date/checkbox to numbers", () => {
    const d = compileFilterToSql(c("d", "eq", "2024-01-01"), undefined, { fields: sqlFields });
    assert.doesNotMatch(d.sql, /double precision|float8/);
    const k = compileFilterToSql(c("c", "eq", true), undefined, { fields: sqlFields });
    assert.doesNotMatch(k.sql, /float8/);
  });
  it("reads computed values (unwrapping legacy objects, honoring _errors) and meta columns", () => {
    const f = compileFilterToSql(c("f", "gte", 1), undefined, { fields: sqlFields });
    assert.match(f.sql, /r\.computed->'_errors'/);
    assert.match(f.sql, /'status'/);
    const a = compileFilterToSql(c("auto", "eq", 3), undefined, { fields: sqlFields });
    assert.match(a.sql, /r\.row_number/);
  });
  it("drops incomplete conditions, errors on unknown fields", () => {
    assert.equal(compileFilterToSql(c("n", "eq"), undefined, { fields: sqlFields }).sql, "TRUE");
    assert.throws(() => compileFilterToSql(c("zz", "eq", 1), undefined, { fields: sqlFields }), FilterError);
    assert.equal(compileFilterToSql(c("zz", "eq", 1), undefined, { fields: sqlFields, unknownField: "ignore" }).sql, "TRUE");
  });
  it("legacy slot map still compiles", () => {
    const r = compileFilterToSql(c("x", "eq", "Acme"), new Map([["x", 4]]));
    assert.match(r.sql, /r\.cells->'4'/);
    assert.deepEqual(r.params, ["acme"]);
  });
  it("lookups compare display text by target type", () => {
    const sel = F("ts", 1, "single_select", { options: [{ id: "opt_z", label: "Zed" }] });
    const usr = F("tu", 1, "collaborator");
    const att = F("ta", 1, "attachment");
    const lnk: SqlFieldInfo = { ...F("tl", 1, "link"), link: { relationId: "rel", side: "a", peerTableId: "peer", peerPrimary: F("pp", 1, "text") } };
    const lk = (target: SqlFieldInfo): SqlFieldInfo => ({ ...F("lk", 9, "lookup", {}, true), lookupTarget: target });
    const run = (target: SqlFieldInfo, op = "contains") =>
      compileFilterToSql(c("lk", op, "zed"), undefined, { fields: new Map([["lk", lk(target)]]) });
    const s = run(sel);
    assert.ok(s.params.some((x) => Array.isArray(x) && x.includes("Zed")), "select labels passed");
    assert.match(s.sql, /unnest/);
    assert.match(run(usr).sql, /core\.users/);
    assert.match(run(att).sql, /data\.attachments at/);
    const l = run(lnk);
    assert.match(l.sql, /data\.records lkr/);
    assert.ok(l.params.includes("peer"));
    assert.match(run(usr, "empty").sql, /EXISTS \(SELECT 1 FROM core\.users/);
    const untargeted = compileFilterToSql(c("lk", "contains", "zed"), undefined, { fields: new Map([["lk", F("lk", 9, "lookup", {}, true)]]) });
    assert.doesNotMatch(untargeted.sql, /core\.users|unnest/);
  });
  it("lookup sort keys use the first element", () => {
    const lk = (target: SqlFieldInfo): SqlFieldInfo => ({ ...F("lk", 9, "lookup", {}, true), lookupTarget: target });
    assert.equal(sortKeysFor(lk(F("n", 1, "number")), "r", new SqlParams())[0]?.type, "float8");
    assert.equal(sortKeysFor(lk(F("s", 1, "single_select", { options: [{ id: "opt_a", label: "A" }] })), "r", new SqlParams())[0]?.type, "int4");
    const u = sortKeysFor(lk(F("u", 1, "collaborator")), "r", new SqlParams())[0]!;
    assert.equal(u.type, "text");
    assert.match(u.expr, /LIMIT 1/);
  });
  it("search ORs display expressions", () => {
    const r = compileSearchToSql("Foo", [...new Set(sqlFields.values())]);
    assert.match(r.sql, / OR /);
    assert.equal(r.params[0], "foo");
  });
});
