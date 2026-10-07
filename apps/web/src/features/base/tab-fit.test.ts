import { deepStrictEqual } from "node:assert";
import { test } from "node:test";
import { computeFloatingPosition } from "./floating-position.ts";
import { fitTabs, moveId } from "./tab-fit.ts";

const ids = ["a", "b", "c", "d", "e"];
const widths = { a: 100, b: 100, c: 100, d: 100, e: 100 };

test("fitTabs fills in order", () => {
  deepStrictEqual(fitTabs(ids, widths, 320, "a"), { shown: ["a", "b", "c"], overflow: ["d", "e"] });
  deepStrictEqual(fitTabs(ids, widths, 1000, "a"), { shown: ids, overflow: [] });
});

test("fitTabs keeps an overflowed active tab in the last slot", () => {
  deepStrictEqual(fitTabs(ids, widths, 320, "e"), { shown: ["a", "b", "e"], overflow: ["c", "d"] });
  deepStrictEqual(fitTabs(ids, { ...widths, e: 250 }, 320, "e"), { shown: ["e"], overflow: ["a", "b", "c", "d"] });
});

test("fitTabs always shows one tab", () => {
  deepStrictEqual(fitTabs(ids, widths, 10, "c"), { shown: ["c"], overflow: ["a", "b", "d", "e"] });
  deepStrictEqual(fitTabs(ids, widths, 10, null), { shown: ["a"], overflow: ["b", "c", "d", "e"] });
  deepStrictEqual(fitTabs([], widths, 10, null), { shown: [], overflow: [] });
});

test("moveId", () => {
  deepStrictEqual(moveId(ids, "e", "a"), ["e", "a", "b", "c", "d"]);
  deepStrictEqual(moveId(ids, "a", null, "c"), ["b", "c", "a", "d", "e"]);
  deepStrictEqual(moveId(ids, "b", null), ["a", "c", "d", "e", "b"]);
  deepStrictEqual(moveId(ids, "b", "b"), ids);
});

test("computeFloatingPosition flips above when there is no room below", () => {
  const vp = { width: 1280, height: 640 };
  const anchor = { left: 8, right: 250, top: 600, bottom: 630 };
  const p = computeFloatingPosition(anchor, { width: 240, height: 300 }, "bottom-start", vp);
  deepStrictEqual(p.top, 600 - 4 - 300);
  const q = computeFloatingPosition(anchor, { width: 240, height: 300 }, "top-start", vp);
  deepStrictEqual(q, p);
});

test("computeFloatingPosition shifts into the viewport and caps height", () => {
  const vp = { width: 800, height: 400 };
  const p = computeFloatingPosition({ left: 700, right: 760, top: 40, bottom: 70 }, { width: 320, height: 900 }, "bottom-start", vp);
  deepStrictEqual(p.left, 800 - 8 - 320);
  deepStrictEqual(p.top, 74);
  deepStrictEqual(p.maxHeight, 400 - 70 - 4 - 8);
  const s = computeFloatingPosition({ left: 600, right: 780, top: 300, bottom: 330 }, { width: 200, height: 150 }, "right-start", vp);
  deepStrictEqual(s.left, 600 - 4 - 200);
  deepStrictEqual(s.top, 400 - 8 - 150);
});
