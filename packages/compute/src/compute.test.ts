import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildFieldGraph, findCycle, planRecompute } from "./index.js";

describe("planRecompute", () => {
  const edges = [
    { dependentFieldId: "f1", dependsOnFieldId: "a" },
    { dependentFieldId: "f2", dependsOnFieldId: "f1" },
    { dependentFieldId: "f3", dependsOnFieldId: "b" },
  ];
  const g = buildFieldGraph(["a", "b", "f1", "f2", "f3"], edges);
  it("orders dependents after their sources", () => {
    assert.deepEqual(planRecompute(g, ["a"]), ["f1", "f2"]);
  });
  it("includes seeds", () => {
    assert.deepEqual(planRecompute(g, [], ["f1"]), ["f1", "f2"]);
    assert.deepEqual(planRecompute(g, ["b"], ["f2"]), ["f2", "f3"]);
  });
});

describe("findCycle", () => {
  it("detects cycles", () => {
    assert.equal(findCycle(["x", "y"], [{ dependentFieldId: "x", dependsOnFieldId: "y" }]), null);
    const c = findCycle(["x", "y"], [
      { dependentFieldId: "x", dependsOnFieldId: "y" },
      { dependentFieldId: "y", dependsOnFieldId: "x" },
    ]);
    assert.ok(c && c[0] === c[c.length - 1]);
  });
});
