import assert from "node:assert/strict";
import { test } from "node:test";
import { encodePublicId } from "@tabula/types";
import { evaluateWireFilter, resolveLookupTargets } from "./filter-eval.js";
import { nextScheduledRun } from "./schedule.js";
import { compareCondition, interpolate, interpolateValue, recordContext, type TableMeta } from "./tokens.js";

const table: TableMeta = {
  id: "tbl_1",
  name: "Tasks",
  views: [],
  fields: [
    { id: "fld_name", name: "Name", type: "text" },
    { id: "fld_status", name: "Status", type: "single_select", config: { options: [{ id: "opt_a", label: "Todo" }, { id: "opt_b", label: "Done" }] } },
    { id: "fld_n", name: "Count", type: "number" },
    { id: "fld_d", name: "Due", type: "date" },
    { id: "fld_who", name: "Owner", type: "collaborator" },
    { id: "fld_full", name: "Full.Name", type: "text" },
  ],
};
const record = {
  id: "rec_1",
  fields: {
    fld_name: "Write docs",
    fld_status: "opt_b",
    fld_n: 5,
    fld_d: "2026-01-10",
    fld_who: [{ id: "usr_1", name: "Ann", email: "ann@x.test" }],
    fld_full: "Ann Lee",
  },
};

test("interpolate field tokens by name with display values", () => {
  const ctx = { trigger: { record: recordContext(table, record) } };
  assert.equal(interpolate("{{trigger.record.fields.Name}} is {{ trigger.record.fields.Status }}", ctx), "Write docs is Done");
  assert.equal(interpolate("{{trigger.record.fields.Owner}}", ctx), "Ann");
  assert.equal(interpolate("{{trigger.record.fields.Full.Name}}", ctx), "Ann Lee");
  assert.equal(interpolate("{{trigger.record.fields.status}}", ctx), "Done");
  assert.equal(interpolate("{{missing.path}}!", ctx), "!");
  assert.deepEqual(interpolateValue("{{trigger.record.raw.Owner}}", ctx), record.fields.fld_who);
  assert.equal(interpolateValue("{{trigger.record.fields.Count}}", ctx), "5");
});

test("filter evaluation on wire records", () => {
  const f = (op: string, fieldId: string, value?: unknown) => ({ kind: "condition", fieldId, op, value });
  assert.equal(evaluateWireFilter(f("eq", "fld_status", "opt_b"), record, table.fields), true);
  assert.equal(evaluateWireFilter(f("eq", "fld_status", "Done"), record, table.fields), true);
  assert.equal(evaluateWireFilter(f("neq", "fld_status", "opt_a"), record, table.fields), true);
  assert.equal(evaluateWireFilter(f("gt", "fld_n", 3), record, table.fields), true);
  assert.equal(evaluateWireFilter(f("lt", "fld_n", "3"), record, table.fields), false);
  assert.equal(evaluateWireFilter(f("contains", "fld_name", "DOC"), record, table.fields), true);
  assert.equal(evaluateWireFilter(f("isBefore", "fld_d", "2026-02-01"), record, table.fields), true);
  assert.equal(evaluateWireFilter(f("isMe", "fld_who"), record, table.fields, { userId: "usr_1" }), true);
  assert.equal(
    evaluateWireFilter({ kind: "or", children: [f("empty", "fld_name"), f("notEmpty", "fld_n")] }, record, table.fields),
    true,
  );
  assert.equal(evaluateWireFilter(null, record, table.fields), true);
});

test("lookup conditions compare target display values (select labels, names, filenames)", () => {
  const u = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, "0")}`;
  const fid = (n: number) => encodePublicId({ prefix: "fld", uuid: u(n) });
  const peer: TableMeta = {
    id: "tbl_2",
    name: "Projects",
    views: [],
    fields: [
      { id: fid(1), name: "Phase", type: "single_select", config: { options: [{ id: "opt_p", label: "Planning" }, { id: "opt_s", label: "Shipped" }] } },
      { id: fid(2), name: "Lead", type: "collaborator" },
      { id: fid(3), name: "Spec", type: "attachment" },
      { id: fid(4), name: "Client", type: "link" },
    ],
  };
  const tasks: TableMeta = {
    id: "tbl_3",
    name: "Tasks",
    views: [],
    fields: [
      { id: "fld_lp", name: "Phase (from Project)", type: "lookup", config: { targetFieldId: fid(1) } },
      { id: "fld_ll", name: "Lead (from Project)", type: "lookup", config: { targetFieldId: u(2) } },
      { id: "fld_la", name: "Spec (from Project)", type: "lookup", config: { lookupFieldId: fid(3) } },
      { id: "fld_lc", name: "Client (from Project)", type: "lookup", config: { targetFieldId: fid(4) } },
    ],
  };
  resolveLookupTargets([peer, tasks]);
  assert.equal(tasks.fields[0]!.lookupTarget?.type, "single_select");
  assert.equal(tasks.fields[1]!.lookupTarget?.type, "collaborator");
  assert.equal(tasks.fields[2]!.lookupTarget?.type, "attachment");
  const rec = {
    id: "rec_9",
    fields: {
      fld_lp: ["opt_s"],
      fld_ll: [{ id: "usr_2", name: "Bea", email: "bea@x.test" }],
      fld_la: [{ id: "att_1", filename: "brief.pdf", url: "https://x.test/brief.pdf" }],
      fld_lc: [{ id: "rec_c", name: "Acme Corp" }],
    },
  };
  const f = (op: string, fieldId: string, value?: unknown) => ({ kind: "condition", fieldId, op, value });
  assert.equal(evaluateWireFilter(f("contains", "fld_lp", "Shipped"), rec, tasks.fields), true);
  assert.equal(evaluateWireFilter(f("eq", "fld_lp", "Shipped"), rec, tasks.fields), true);
  assert.equal(evaluateWireFilter(f("contains", "fld_lp", "Planning"), rec, tasks.fields), false);
  assert.equal(evaluateWireFilter(f("contains", "fld_lp", "opt_s"), rec, tasks.fields), false);
  assert.equal(evaluateWireFilter(f("contains", "fld_ll", "Bea"), rec, tasks.fields), true);
  assert.equal(evaluateWireFilter(f("contains", "fld_la", "brief"), rec, tasks.fields), true);
  assert.equal(evaluateWireFilter(f("contains", "fld_lc", "acme"), rec, tasks.fields), true);
  const ctx = { trigger: { record: recordContext(tasks, rec) } };
  assert.equal(interpolate("{{trigger.record.fields.Phase (from Project)}}", ctx), "Shipped");
});

test("branch condition comparisons", () => {
  assert.equal(compareCondition("10", "gt", "9"), true);
  assert.equal(compareCondition("abc", "contains", "B"), true);
  assert.equal(compareCondition("", "empty", undefined), true);
  assert.equal(compareCondition("Done", "eq", "done"), true);
});

test("schedule next run", () => {
  const at = new Date("2026-03-04T10:07:30Z"); // Wednesday
  assert.equal(nextScheduledRun({ interval: "minutes", every: 15 }, at).toISOString(), "2026-03-04T10:15:00.000Z");
  assert.equal(nextScheduledRun({ interval: "hourly", minute: 5 }, at).toISOString(), "2026-03-04T11:05:00.000Z");
  assert.equal(nextScheduledRun({ interval: "daily", time: "09:00" }, at).toISOString(), "2026-03-05T09:00:00.000Z");
  assert.equal(nextScheduledRun({ interval: "weekly", weekday: 1, time: "08:30" }, at).toISOString(), "2026-03-09T08:30:00.000Z");
  assert.equal(
    nextScheduledRun({ interval: "daily", time: "09:00", timeZone: "America/New_York" }, at).toISOString(),
    "2026-03-04T14:00:00.000Z",
  );
});
