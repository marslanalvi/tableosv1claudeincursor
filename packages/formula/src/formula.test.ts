import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateFormula,
  FormulaEvalError,
  FormulaParseError,
  formulaFieldRefs,
  parseFormula,
  rewriteFormulaRefs,
  type RuntimeValue,
} from "./index.js";

const NOW = new Date("2024-03-15T10:30:00.000Z");
const fields: Record<string, RuntimeValue> = {
  Name: "Widget",
  Price: 12.5,
  Qty: 4,
  Empty: null,
  Due: "2024-03-20",
  Start: "2024-01-31",
  Tags: ["a", "b", "a"],
  Nums: [1, 2, 3],
  Done: true,
  "Unit Price": 3,
};

function ev(expr: string): unknown {
  return evaluateFormula(parseFormula(expr), {
    getField: (ref) => (ref in fields ? fields[ref] : undefined),
    recordId: "rec_123",
    now: NOW,
  });
}

describe("parser", () => {
  it("parses precedence and comparisons", () => {
    assert.equal(ev("1 + 2 * 3"), 7);
    assert.equal(ev("(1 + 2) * 3"), 9);
    assert.equal(ev("2 * 3 > 5"), true);
    assert.equal(ev('"a" & 1 + 2'), "a3");
    assert.equal(ev("-{Qty} + 1"), -3);
    assert.equal(ev("1 != 2"), true);
    assert.equal(ev("1 <> 1"), false);
    assert.equal(ev("3 >= 3 AND 2 < 1"), false);
  });
  it("supports bare field identifiers and escapes", () => {
    assert.equal(ev("Price * Qty"), 50);
    assert.equal(ev("{Unit Price} * 2"), 6);
    assert.equal(ev('"say \\"hi\\""'), 'say "hi"');
  });
  it("reports syntax errors", () => {
    assert.throws(() => parseFormula("1 +"), FormulaParseError);
    assert.throws(() => parseFormula("IF(1, 2"), FormulaParseError);
    assert.throws(() => parseFormula("{Name"), FormulaParseError);
    assert.throws(() => parseFormula("1 2"), FormulaParseError);
  });
  it("collects and rewrites references", () => {
    const ast = parseFormula("{Price} * Qty + {Price}");
    assert.deepEqual(formulaFieldRefs(ast), ["Price", "Qty"]);
    const out = rewriteFormulaRefs("{Price} * Qty + LEN({Name})", (r) => `id_${r}`);
    assert.equal(out, "{id_Price} * {id_Qty} + LEN({id_Name})");
    assert.equal(rewriteFormulaRefs("IF(x, 1)", () => null), "IF(x, 1)");
  });
});

describe("logical", () => {
  it("IF/SWITCH/AND/OR/NOT/XOR", () => {
    assert.equal(ev('IF({Price} > 10, "big", "small")'), "big");
    assert.equal(ev('IF({Empty}, "y")'), null);
    assert.equal(ev('SWITCH({Qty}, 1, "one", 4, "four", "other")'), "four");
    assert.equal(ev('SWITCH({Qty}, 1, "one", "other")'), "other");
    assert.equal(ev('AND(1, {Done}, "x")'), true);
    assert.equal(ev("OR(0, BLANK())"), false);
    assert.equal(ev("NOT({Empty})"), true);
    assert.equal(ev("XOR(1, 1, 1)"), true);
  });
  it("errors and ISERROR / IFERROR", () => {
    assert.throws(() => ev("1/0"), FormulaEvalError);
    assert.throws(() => ev('ERROR("bad")'), FormulaEvalError);
    assert.equal(ev("ISERROR(1/0)"), true);
    assert.equal(ev("IFERROR(1/0, -1)"), -1);
    assert.equal(ev("IF(TRUE, 1, 1/0)"), 1);
    assert.throws(() => ev("NOPE(1)"), FormulaEvalError);
    assert.throws(() => ev("{Missing}"), FormulaEvalError);
  });
  it("blank comparisons", () => {
    assert.equal(ev("{Empty} = BLANK()"), true);
    assert.equal(ev('{Empty} = ""'), true);
    assert.equal(ev("{Empty} = 0"), true);
    assert.equal(ev("{Empty} + 1"), 1);
  });
});

describe("math", () => {
  it("rounding and arithmetic", () => {
    assert.equal(ev("ROUND(2.5)"), 3);
    assert.equal(ev("ROUND(-2.5)"), -3);
    assert.equal(ev("ROUND(1.005, 2)"), 1.01);
    assert.equal(ev("ROUNDUP(1.21, 1)"), 1.3);
    assert.equal(ev("ROUNDDOWN(-1.29, 1)"), -1.2);
    assert.equal(ev("FLOOR(7, 5)"), 5);
    assert.equal(ev("CEILING(7, 5)"), 10);
    assert.equal(ev("INT(-1.5)"), -2);
    assert.equal(ev("MOD(-3, 5)"), 2);
    assert.equal(ev("POWER(2, 10)"), 1024);
    assert.equal(ev("SQRT(16)"), 4);
    assert.equal(ev("LOG(100)"), 2);
    assert.equal(ev("ABS(-3)"), 3);
    assert.equal(ev("EVEN(3)"), 4);
    assert.equal(ev("ODD(4)"), 5);
    assert.equal(ev("0.1 + 0.2"), 0.3);
  });
  it("aggregates over arrays", () => {
    assert.equal(ev("SUM({Nums})"), 6);
    assert.equal(ev("SUM(1, 2, {Nums})"), 9);
    assert.equal(ev("AVERAGE({Nums})"), 2);
    assert.equal(ev("MAX({Nums}, 10)"), 10);
    assert.equal(ev("MIN({Nums})"), 1);
    assert.equal(ev('COUNT(1, "2", "x", BLANK())'), 2);
    assert.equal(ev('COUNTA(1, "", "x")'), 2);
    assert.equal(ev('VALUE("$1,200.50")'), 1200.5);
  });
});

describe("text", () => {
  it("string functions", () => {
    assert.equal(ev('CONCATENATE({Name}, "-", {Qty})'), "Widget-4");
    assert.equal(ev("LEFT({Name}, 3)"), "Wid");
    assert.equal(ev("RIGHT({Name}, 3)"), "get");
    assert.equal(ev("MID({Name}, 2, 3)"), "idg");
    assert.equal(ev("LEN({Name})"), 6);
    assert.equal(ev('UPPER({Name}) & LOWER("AB")'), "WIDGETab");
    assert.equal(ev('TRIM("  a   b ")'), "a b");
    assert.equal(ev('FIND("g", {Name})'), 4);
    assert.equal(ev('FIND("z", {Name})'), 0);
    assert.equal(ev('SEARCH("W", "awa")'), 2);
    assert.equal(ev('SUBSTITUTE("a-b-c", "-", "+")'), "a+b+c");
    assert.equal(ev('SUBSTITUTE("a-b-c", "-", "+", 2)'), "a-b+c");
    assert.equal(ev('REPLACE("abcdef", 2, 3, "X")'), "aXef");
    assert.equal(ev('REPT("ab", 3)'), "ababab");
    assert.equal(ev('REGEX_MATCH("abc123", "[0-9]+")'), true);
    assert.equal(ev('REGEX_EXTRACT("abc123", "[0-9]+")'), "123");
    assert.equal(ev('REGEX_REPLACE("a1b2", "[0-9]", "")'), "ab");
    assert.equal(ev('ENCODE_URL_COMPONENT("a b")'), "a%20b");
    assert.equal(ev('"Total: " & {Price}'), "Total: 12.5");
  });
});

describe("arrays", () => {
  it("array functions", () => {
    assert.equal(ev('ARRAYJOIN({Tags}, "; ")'), "a; b; a");
    assert.deepEqual(ev("ARRAYUNIQUE({Tags})"), ["a", "b"]);
    assert.deepEqual(ev("ARRAYCOMPACT(ARRAYFLATTEN({Tags}))"), ["a", "b", "a"]);
    assert.deepEqual(ev("ARRAYSLICE({Nums}, 2)"), [2, 3]);
    assert.equal(ev('{Tags} & ""'), "a, b, a");
  });
});

describe("dates", () => {
  it("TODAY / NOW", () => {
    assert.equal(ev("TODAY()"), "2024-03-15T00:00:00.000Z");
    assert.equal(ev("NOW()"), "2024-03-15T10:30:00.000Z");
  });
  it("DATEADD and DATETIME_DIFF", () => {
    assert.equal(ev('DATEADD({Due}, 10, "days")'), "2024-03-30T00:00:00.000Z");
    assert.equal(ev('DATEADD({Start}, 1, "month")'), "2024-02-29T00:00:00.000Z");
    assert.equal(ev('DATEADD({Due}, -1, "years")'), "2023-03-20T00:00:00.000Z");
    assert.equal(ev('DATETIME_DIFF({Due}, TODAY(), "days")'), 5);
    assert.equal(ev('DATETIME_DIFF({Due}, {Start}, "months")'), 1);
    assert.equal(ev("DATETIME_DIFF({Due}, {Start}, 'w')"), 7);
    assert.equal(ev('DATETIME_DIFF("2024-01-01T01:00:00Z", "2024-01-01T00:00:00Z")'), 3600);
  });
  it("DATETIME_FORMAT / PARSE and parts", () => {
    assert.equal(ev('DATETIME_FORMAT({Due}, "MM/DD/YYYY")'), "03/20/2024");
    assert.equal(ev('DATETIME_FORMAT(NOW(), "dddd, MMMM Do YYYY h:mm A")'), "Friday, March 15th 2024 10:30 AM");
    assert.equal(ev('DATETIME_FORMAT({Due}, "LL")'), "March 20, 2024");
    assert.equal(ev('DATETIME_PARSE("20/03/2024", "DD/MM/YYYY")'), "2024-03-20T00:00:00.000Z");
    assert.equal(ev("DATESTR(NOW())"), "2024-03-15");
    assert.equal(ev('YEAR({Due}) & "-" & MONTH({Due}) & "-" & DAY({Due})'), "2024-3-20");
    assert.equal(ev("HOUR(NOW())"), 10);
    assert.equal(ev("WEEKDAY({Due})"), 3);
    assert.equal(ev('WEEKDAY({Due}, "Monday")'), 2);
    assert.equal(ev("WEEKNUM({Due})"), 12);
    assert.equal(ev("IS_BEFORE({Start}, {Due})"), true);
    assert.equal(ev("IS_AFTER({Start}, {Due})"), false);
    assert.equal(ev('IS_SAME({Due}, "2024-03-20T18:00:00Z", "day")'), true);
    assert.equal(ev("WORKDAY({Due}, 3)"), "2024-03-25T00:00:00.000Z");
    assert.equal(ev('WORKDAY_DIFF({Due}, "2024-03-26")'), 5);
    assert.equal(ev("{Due} < {Start}"), false);
    assert.equal(ev("DATETIME_DIFF({Empty}, {Due}, 'days')"), null);
    assert.throws(() => ev('DATEADD("nope", 1, "days")'), FormulaEvalError);
  });
  it("RECORD_ID", () => {
    assert.equal(ev("RECORD_ID()"), "rec_123");
  });
});
