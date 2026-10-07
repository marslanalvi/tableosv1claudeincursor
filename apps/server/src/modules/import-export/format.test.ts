import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeCsv, exportValue, guardFormula, toCsv } from "./format.js";
import { buildXlsx } from "./xlsx.js";

const sel = {
  id: "fld_s",
  name: "Status",
  type: "single_select",
  config: { options: [{ id: "opt_a", label: "Todo" }, { id: "opt_b", label: "=cmd" }] },
};

test("formula injection guard", () => {
  assert.equal(guardFormula("=SUM(A1)"), "'=SUM(A1)");
  assert.equal(guardFormula("+1"), "'+1");
  assert.equal(guardFormula("@x"), "'@x");
  assert.equal(guardFormula("hello"), "hello");
  assert.equal(exportValue({ id: "f", name: "t", type: "text", config: {} }, "-2+3"), "'-2+3");
  // numbers are not guarded
  assert.equal(exportValue({ id: "f", name: "n", type: "number", config: {} }, -5), "-5");
  assert.equal(exportValue({ id: "f", name: "n", type: "number", config: {} }, -5, { keepNumbers: true }), -5);
});

test("select labels", () => {
  assert.equal(exportValue(sel, "opt_a"), "Todo");
  assert.equal(exportValue(sel, "opt_b"), "'=cmd");
  assert.equal(exportValue({ ...sel, type: "multi_select" }, ["opt_a", "opt_b"]), "Todo, =cmd");
});

test("hydrated values", () => {
  assert.equal(
    exportValue({ id: "f", name: "l", type: "link", config: {} }, [{ id: "rec_1", name: "A" }, { id: "rec_2", name: "B" }]),
    "A, B",
  );
  assert.equal(
    exportValue({ id: "f", name: "a", type: "attachment", config: {} }, [{ filename: "x.png", url: "/v1/x" }], {
      absoluteUrl: (u) => `http://h${u}`,
    }),
    "x.png (http://h/v1/x)",
  );
  assert.equal(exportValue({ id: "f", name: "c", type: "checkbox", config: {} }, true), "checked");
});

test("csv escaping", () => {
  assert.equal(escapeCsv('a,"b"'), '"a,""b"""');
  assert.equal(toCsv([["a", 1], ["x\ny", null]]), '﻿a,1\r\n"x\ny",');
});

test("xlsx is a zip", () => {
  const buf = buildXlsx("Sheet", [["Name", "N"], ["a<b", 2]]);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
});
