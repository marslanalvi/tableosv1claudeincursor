import { test } from "node:test";
import assert from "node:assert/strict";
import { convertValue, detectType, normalizeDate, parseDelimited, toSheet } from "./parse.ts";

test("csv quoting and newlines", () => {
  const rows = parseDelimited('name,notes\r\n"Ada, L","line1\nline2"\n"say ""hi""",x\n');
  assert.deepEqual(rows, [
    ["name", "notes"],
    ["Ada, L", "line1\nline2"],
    ['say "hi"', "x"],
  ]);
});

test("delimiter detection", () => {
  assert.deepEqual(parseDelimited("a\tb\n1\t2"), [["a", "b"], ["1", "2"]]);
  assert.deepEqual(parseDelimited("a;b\n1;2"), [["a", "b"], ["1", "2"]]);
});

test("sheet headers", () => {
  const s = toSheet([["Name", "name", ""], ["a", "b"], ["", "", ""]], true);
  assert.deepEqual(s.headers, ["Name", "name (2)", "Field 3"]);
  assert.equal(s.rows.length, 1);
});

test("type detection", () => {
  assert.equal(detectType(["1", "2.5", "-3", "1,000"]), "number");
  assert.equal(detectType(["$1.00", "$20"]), "currency");
  assert.equal(detectType(["10%", "5 %"]), "percent");
  assert.equal(detectType(["yes", "no", "yes"]), "checkbox");
  assert.equal(detectType(["2026-01-02", "1/3/2026"]), "date");
  assert.equal(detectType(["a@b.co", "x@y.org"]), "email");
  assert.equal(detectType(["https://a.com", "www.b.org"]), "url");
  assert.equal(detectType(["Todo", "Done", "Todo", "Done", "Todo", "Doing", "Done"]), "single_select");
  assert.equal(detectType(["Alice", "Bob", "Carol"]), "text");
});

test("value conversion", () => {
  assert.equal(normalizeDate("12/31/2025"), "2025-12-31");
  assert.equal(normalizeDate("31/12/2025"), "2025-12-31");
  assert.equal(normalizeDate("Mar 5, 2024"), "2024-03-05");
  assert.equal(normalizeDate("2024-02-30"), null);
  assert.equal(convertValue("number", "$1,200.50"), 1200.5);
  assert.equal(convertValue("number", "(5)"), -5);
  assert.equal(convertValue("checkbox", "Yes"), true);
  assert.equal(convertValue("checkbox", "no"), undefined);
  assert.deepEqual(convertValue("multi_select", "a, b,a"), ["a", "b"]);
  assert.equal(convertValue("text", "  "), undefined);
});
