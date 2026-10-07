import assert from "node:assert/strict";
import { test } from "node:test";
import { entryFromChange, sourceOf, type ChangeLogRow, type EntryContext, type HistoryFieldMeta } from "./record-history.js";

const R = "00000000-0000-7000-8000-000000000001";
const P = "00000000-0000-7000-8000-000000000002";
const F_NAME = "00000000-0000-7000-8000-0000000000f1";
const F_FORMULA = "00000000-0000-7000-8000-0000000000f2";
const F_LINK = "00000000-0000-7000-8000-0000000000f3";
const F_INV = "00000000-0000-7000-8000-0000000000f4";

const fields: Record<string, HistoryFieldMeta> = {
  "1": { id: F_NAME, slot: 1, name: "Name", type: "text", config: {}, isComputed: false, deleted: false },
  "2": { id: F_FORMULA, slot: 2, name: "Calc", type: "formula", config: {}, isComputed: true, deleted: false },
};
const ctx: EntryContext = {
  fieldForSlot: (slot) => fields[slot],
  peerFieldOf: (f) => (f === F_LINK ? F_INV : f === F_INV ? F_LINK : null),
};

function row(ops: unknown[], inverse: unknown[] | null = null, extra: Partial<ChangeLogRow> = {}): ChangeLogRow {
  return {
    seq: 10,
    created_at: "2026-10-07T10:00:00Z",
    actor_type: "user",
    actor_id: "u",
    via: "api",
    client_mutation_id: null,
    ops,
    inverse_ops: inverse,
    ...extra,
  };
}

test("cell diff ignores unchanged, computed and unknown slots", () => {
  const e = entryFromChange(
    row(
      [{ op: "record.updated", recordId: R, cells: { "1": "B", "2": 5, "9": "x" } }],
      [{ op: "record.updated", recordId: R, cells: { "1": "A", "2": 4 } }],
    ),
    R,
    ctx,
  );
  assert.deepEqual(e?.changes, [{ fieldId: F_NAME, before: "A", after: "B" }]);
});

test("a write that changes nothing visible yields no entry; computed-only ops are skipped", () => {
  assert.equal(
    entryFromChange(row([{ op: "record.updated", recordId: R, cells: { "1": "A" } }], [{ op: "record.updated", recordId: R, cells: { "1": "A" } }]), R, ctx),
    null,
  );
  assert.equal(entryFromChange(row([{ op: "records.computed", tableId: "t", recordIds: [R] }]), R, ctx), null);
});

test("undo rows: prevCells give old values; legacy rows without values are kept as not detailed", () => {
  const e = entryFromChange(row([{ op: "record.updated", recordId: R, cells: { "1": "A" }, prevCells: { "1": "B" } }], null, { via: "undo" }), R, ctx);
  assert.deepEqual(e?.changes, [{ fieldId: F_NAME, before: "B", after: "A" }]);
  const legacy = entryFromChange(row([{ op: "record.updated", recordId: R }], null, { via: "undo" }), R, ctx);
  assert.equal(legacy?.kind, "updated");
  assert.equal(legacy?.detailed, false);
});

test("links: own diffs, peer diffs, and the links route", () => {
  const own = entryFromChange(
    row([{ op: "record.updated", recordId: R, cells: {}, links: [{ recordId: R, fieldId: F_LINK, added: [P], removed: [], peerFieldId: F_INV }] }], [
      { op: "record.updated", recordId: R, cells: {} },
    ]),
    R,
    ctx,
  );
  assert.deepEqual(own?.changes, [{ fieldId: F_LINK, added: [P], removed: [] }]);
  const peer = entryFromChange(
    row([{ op: "record.updated", recordId: R, cells: {}, links: [{ recordId: R, fieldId: F_LINK, added: [], removed: [P], peerFieldId: F_INV }] }]),
    P,
    ctx,
  );
  assert.equal(peer?.kind, "updated");
  assert.deepEqual(peer?.changes, [{ fieldId: F_INV, added: [], removed: [R] }]);
  const route = [
    { op: "link.add", recordId: R, fieldId: F_LINK, targets: [P] },
    { op: "records.links_changed", tableId: "t2", recordIds: [P] },
  ];
  assert.deepEqual(entryFromChange(row(route), R, ctx)?.changes, [{ fieldId: F_LINK, added: [P], removed: [] }]);
  assert.deepEqual(entryFromChange(row(route), P, ctx)?.changes, [{ fieldId: F_INV, added: [R], removed: [] }]);
});

test("kinds and sources", () => {
  assert.equal(entryFromChange(row([{ op: "records.created", recordIds: [P, R] }]), R, ctx)?.kind, "created");
  assert.equal(entryFromChange(row([{ op: "records.soft_deleted", recordIds: [R], batchId: "b" }]), R, ctx)?.kind, "deleted");
  const dup = entryFromChange(row([{ op: "record.created", recordId: R, duplicatedFrom: P }]), R, ctx);
  assert.equal(dup?.duplicatedFrom, P);
  assert.equal(entryFromChange(row([{ op: "record.created", recordId: P, duplicatedFrom: R }]), R, ctx), null);
  const base = { kind: "updated" as const, actorType: "user", via: "api", clientMutationId: null };
  assert.equal(sourceOf(base, null), "user");
  assert.equal(sourceOf({ ...base, clientMutationId: "aut:123" }, null), "automation");
  assert.equal(sourceOf({ ...base, via: "restore" }, null), "restore");
  assert.equal(sourceOf({ ...base, kind: "created", actorType: "system" }, "form"), "form");
  assert.equal(sourceOf({ ...base, kind: "created" }, "import"), "import");
  assert.equal(sourceOf({ ...base, actorType: "system" }, "form"), "system");
});
