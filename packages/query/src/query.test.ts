import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SqlParams, type SqlFieldInfo } from "@tabula/filter";
import {
  buildRecordPageSql,
  cursorPredicate,
  decodeRecordCursor,
  encodeRecordCursor,
  InvalidCursorError,
  nextCursorFromRow,
  planRecordQuery,
} from "./index.js";

const fields = new Map<string, SqlFieldInfo>([
  ["fld_n", { id: "n", slot: 2, type: "number", config: {}, isComputed: false }],
  ["fld_s", { id: "s", slot: 3, type: "single_select", config: { options: [{ id: "opt_a", label: "A" }] }, isComputed: false }],
]);

describe("cursor", () => {
  it("round-trips and checks the sort signature", () => {
    const enc = encodeRecordCursor("sig1", { keys: ["1.5", null, "a0"], id: "u" });
    assert.deepEqual(decodeRecordCursor(enc, "sig1", false), { keys: ["1.5", null, "a0"], id: "u" });
    assert.throws(() => decodeRecordCursor(enc, "sig2", false), InvalidCursorError);
    assert.throws(() => decodeRecordCursor("%%%", "sig1", true), InvalidCursorError);
    assert.deepEqual(decodeRecordCursor("a0|abc", "x", true), { keys: ["a0"], id: "abc" });
  });
});

describe("keyset predicate", () => {
  it("handles NULLS LAST in both directions", () => {
    const p = new SqlParams();
    const sql = cursorPredicate(
      [
        { ref: "k0", type: "float8", direction: "desc" },
        { ref: "k1", type: "text", direction: "asc" },
      ],
      "id",
      "desc",
      { keys: [null, "x"], id: "u" },
      p,
    );
    // k0 is NULL: nothing after it except other NULLs → equality branch only.
    assert.equal(sql, "(k0 IS NULL AND (k1 > $1::text OR k1 IS NULL)) OR (k0 IS NULL AND k1 = $1::text AND id < $2::uuid)");
    assert.deepEqual(p.values, ["x", "u"]);
  });
});

describe("planner", () => {
  it("builds typed multi-level order with manual-order + id tiebreakers", () => {
    const p = new SqlParams(["tbl"]);
    const plan = planRecordQuery(
      { pageSize: 10, sort: [{ fieldId: "fld_s", direction: "desc" }, { fieldId: "fld_n", direction: "asc" }] },
      { fields },
      p,
    );
    assert.equal(plan.keys.length, 3);
    assert.equal(plan.keys[2]!.fieldId, "manualOrder");
    assert.equal(plan.idDirection, "desc");
    const sql = buildRecordPageSql(plan, { tableIdSql: "$1::uuid", params: p });
    assert.match(sql, /ORDER BY q\._k0 DESC NULLS LAST, q\._k1 ASC NULLS LAST, q\._k2 ASC NULLS LAST, q\.id DESC/);
    assert.match(sql, /array_position/);
    const cur = nextCursorFromRow(plan, { id: "u", _kt0: "1", _kt1: null, _kt2: "a0" });
    const plan2 = planRecordQuery(
      { pageSize: 10, sort: [{ fieldId: "fld_s", direction: "desc" }, { fieldId: "fld_n", direction: "asc" }], cursor: cur },
      { fields },
      new SqlParams(["tbl"]),
    );
    assert.deepEqual(plan2.cursor, { keys: ["1", null, "a0"], id: "u" });
  });
  it("rejects unknown sort fields", () => {
    assert.throws(() => planRecordQuery({ pageSize: 1, sort: [{ fieldId: "nope", direction: "asc" }] }, { fields }));
  });
});
