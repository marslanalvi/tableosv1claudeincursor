/**
 * Test fixture for query/filter integration tests (workstream A).
 * Creates a user/base via the HTTP API and then inserts fields of every type,
 * records (including legacy / malformed values), links and attachments directly
 * via SQL, so the read path can be exercised independently of the write path.
 *
 * Requires a running API (TABULA_API_URL, default http://localhost:3200) and
 * DATABASE_URL (default the dev `tabula_cc` database).
 */
// @ts-ignore -- no @types/pg in this workspace; test-only helper
import pg from "pg";
import { generateUuidV7 } from "@tabula/types";
import { decodePublicId, encodePublicId } from "@tabula/types";

export const API = process.env["TABULA_API_URL"] ?? "http://localhost:3200";
export const DB_URL = process.env["DATABASE_URL"] ?? "postgres://tabula:tabula@localhost:5432/tabula_cc";

export type Api = <T = any>(method: string, path: string, body?: unknown) => Promise<{ status: number; body: T }>;

export function apiClient(): Api {
  let cookie = "";
  return async (method, path, body) => {
    let res: Response | undefined;
    for (let attempt = 0; ; attempt++) {
      try {
        res = await fetch(API + path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        });
        break;
      } catch (e) {
        // API hot-reloads while other workstreams edit; wait and retry.
        if (attempt > 60) throw e;
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    const sc = res.headers.getSetCookie?.() ?? [];
    if (sc.length) cookie = sc.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json };
  };
}

const uuidOf = (p: string) => decodePublicId(p).uuid;
export const pidOf = (prefix: "fld" | "rec" | "usr" | "att" | "opt", uuid: string) => encodePublicId({ prefix: prefix as any, uuid });

export interface FieldSpec {
  key: string;
  name: string;
  type: string;
  config?: Record<string, unknown>;
  computed?: boolean;
}

export interface Fixture {
  api: Api;
  pool: any;
  baseId: string; // bas_
  tableId: string; // tbl_
  peerTableId: string; // tbl_
  baseUuid: string;
  tableUuid: string;
  peerUuid: string;
  userId: string; // usr_
  userUuid: string;
  otherUserUuid: string;
  fields: Record<
    string,
    {
      id: string;
      uuid: string;
      slot: number;
      type: string;
      config: Record<string, unknown>;
      lookupTarget?: { id: string; type: string; config: Record<string, unknown> };
    }
  >;
  recordUuids: string[];
  peerRecordUuids: string[];
}

export const OPTS = [
  { id: "opt_a", label: "Alpha", color: "blue" },
  { id: "opt_b", label: "Beta", color: "red" },
  { id: "opt_c", label: "Gamma", color: "green" },
];
export const TAGS = [
  { id: "opt_x", label: "X-ray", color: "blue" },
  { id: "opt_y", label: "Yankee", color: "red" },
  { id: "opt_z", label: "Zulu", color: "green" },
];
/** Options of the peer table's select (looked up from the main table). */
export const PEER_OPTS = [
  { id: "opt_p1", label: "Zebra", color: "blue" },
  { id: "opt_p2", label: "Mango", color: "red" },
];

export const FIELD_SPECS: FieldSpec[] = [
  { key: "notes", name: "Notes", type: "long_text" },
  { key: "email", name: "Email", type: "email" },
  { key: "num", name: "Num", type: "number", config: { precision: 2 } },
  { key: "price", name: "Price", type: "currency", config: { symbol: "$", precision: 2 } },
  { key: "pct", name: "Pct", type: "percent" },
  { key: "rate", name: "Rate", type: "rating", config: { max: 5 } },
  { key: "dur", name: "Dur", type: "duration" },
  { key: "done", name: "Done", type: "checkbox" },
  { key: "day", name: "Day", type: "date" },
  { key: "when", name: "When", type: "datetime", config: { timeZone: "America/New_York" } },
  { key: "status", name: "Status", type: "single_select", config: { options: OPTS } },
  { key: "tags", name: "Tags", type: "multi_select", config: { options: TAGS } },
  { key: "owner", name: "Owner", type: "collaborator", config: { allowMultiple: true } },
  { key: "files", name: "Files", type: "attachment" },
  { key: "code", name: "Code", type: "barcode" },
  { key: "fnum", name: "FNum", type: "formula", config: { expression: "x", resultType: "number" }, computed: true },
  { key: "ftext", name: "FText", type: "formula", config: { expression: "y" }, computed: true },
  { key: "auto", name: "Auto", type: "autonumber" },
  { key: "ctime", name: "CTime", type: "created_time" },
  { key: "mtime", name: "MTime", type: "modified_time" },
  { key: "cby", name: "CBy", type: "created_by" },
  { key: "mby", name: "MBy", type: "modified_by" },
  { key: "link", name: "Link", type: "link" },
  { key: "look", name: "Look", type: "lookup", computed: true },
  { key: "lstatus", name: "LStatus", type: "lookup", computed: true },
  { key: "lowner", name: "LOwner", type: "lookup", computed: true },
  { key: "lfiles", name: "LFiles", type: "lookup", computed: true },
  { key: "lmain", name: "LMain", type: "lookup", computed: true },
];

/** Fields on the peer table that the l* lookups above target. */
const PEER_FIELD_SPECS: { key: string; name: string; type: string; config: Record<string, unknown> }[] = [
  { key: "lstatus", name: "PStatus", type: "single_select", config: { options: PEER_OPTS } },
  { key: "lowner", name: "POwner", type: "collaborator", config: { allowMultiple: true } },
  { key: "lfiles", name: "PFiles", type: "attachment", config: {} },
];

/** Deterministic PRNG. */
export function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export async function createFixture(nRecords = 60, seed = 42): Promise<Fixture> {
  const api = apiClient();
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const su = await api("POST", "/v1/auth/signup", { email: `ws-a-${stamp}@tabula.test`, password: "Passw0rd!Passw0rd!", name: "Ada Tester" });
  if (su.status >= 400) throw new Error(`signup ${su.status} ${JSON.stringify(su.body)}`);
  const userId: string = su.body.user.id;
  const wsId: string = su.body.workspace.id;
  const base = await api("POST", `/v1/workspaces/${wsId}/bases`, { name: "Query Fixture" });
  if (base.status >= 400) throw new Error(`base ${base.status} ${JSON.stringify(base.body)}`);
  const baseId: string = base.body.id ?? base.body.base?.id;
  const t2 = await api("POST", `/v1/bases/${baseId}/tables`, { name: "Peers" });
  if (t2.status >= 400) throw new Error(`table ${t2.status} ${JSON.stringify(t2.body)}`);
  const detail = await api("GET", `/v1/bases/${baseId}`);
  const tables = detail.body.tables as any[];
  const peer = tables.find((t) => t.name === "Peers");
  const main = tables.find((t) => t.name !== "Peers");
  const pool = new pg.Pool({ connectionString: DB_URL, max: 3 });
  const baseUuid = uuidOf(baseId);
  const tableUuid = uuidOf(main.id);
  const peerUuid = uuidOf(peer.id);
  const userUuid = uuidOf(userId);
  const ws = (await pool.query(`SELECT workspace_id FROM data.bases WHERE id = $1`, [baseUuid])).rows[0].workspace_id;

  // Second user (collaborator values / isMe negatives).
  const otherUserUuid = generateUuidV7();
  await pool.query(
    `INSERT INTO core.users (id, email, email_normalized, display_name) VALUES ($1, $2, $2, 'Bob Other')`,
    [otherUserUuid, `ws-a-other-${stamp}@tabula.test`],
  );

  // Primary fields of both tables.
  const prim = async (tUuid: string) =>
    (await pool.query(`SELECT f.id, f.slot, f.type FROM data.tables t JOIN data.fields f ON f.id = t.primary_field_id WHERE t.id = $1`, [tUuid])).rows[0];
  const mainPrim = await prim(tableUuid);
  const peerPrim = await prim(peerUuid);
  // Make sure primaries are plain text.
  await pool.query(`UPDATE data.fields SET type = 'text', config = '{}' WHERE id = ANY($1::uuid[])`, [[mainPrim.id, peerPrim.id]]);
  // Remove any other default fields on the main table so slots are ours.
  await pool.query(`UPDATE data.fields SET deleted_at = now() WHERE table_id = $1 AND id <> $2`, [tableUuid, mainPrim.id]);
  await pool.query(`UPDATE data.fields SET deleted_at = now() WHERE table_id = $1 AND id <> $2`, [peerUuid, peerPrim.id]);
  await pool.query(`DELETE FROM data.records WHERE table_id = ANY($1::uuid[])`, [[tableUuid, peerUuid]]);

  const fields: Fixture["fields"] = {
    name: { id: pidOf("fld", mainPrim.id), uuid: mainPrim.id, slot: mainPrim.slot, type: "text", config: {} },
  };
  const maxSlot = (await pool.query(`SELECT COALESCE(max(slot), 0) AS m FROM data.fields WHERE table_id = $1`, [tableUuid])).rows[0].m as number;
  let slot = maxSlot + 1;
  const linkFieldUuid = generateUuidV7();
  const inverseUuid = generateUuidV7();
  const peerFieldUuids = new Map(PEER_FIELD_SPECS.map((s) => [s.key, generateUuidV7()]));
  const lookupTargets: Record<string, { id: string; type: string; config: Record<string, unknown> }> = {
    look: { id: peerPrim.id, type: "text", config: {} },
    lmain: { id: inverseUuid, type: "link", config: {} },
  };
  for (const s of PEER_FIELD_SPECS) lookupTargets[s.key] = { id: peerFieldUuids.get(s.key)!, type: s.type, config: s.config };
  for (const spec of FIELD_SPECS) {
    const id = spec.key === "link" ? linkFieldUuid : generateUuidV7();
    let config = spec.config ?? {};
    const target = lookupTargets[spec.key];
    if (target) config = { linkFieldId: linkFieldUuid, targetFieldId: target.id };
    await pool.query(
      `INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, type, config, order_key, is_computed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, ws, baseUuid, tableUuid, slot, spec.name, spec.type, JSON.stringify(config), `b${String(slot).padStart(4, "0")}`, !!spec.computed],
    );
    fields[spec.key] = { id: pidOf("fld", id), uuid: id, slot, type: spec.type, config, ...(target ? { lookupTarget: target } : {}) };
    slot++;
  }
  await pool.query(`UPDATE data.tables SET next_field_slot = $2 WHERE id = $1`, [tableUuid, slot]);
  // Inverse link field on the peer table + relation.
  const peerSlot = ((await pool.query(`SELECT COALESCE(max(slot), 0) AS m FROM data.fields WHERE table_id = $1`, [peerUuid])).rows[0].m as number) + 1;
  await pool.query(
    `INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, type, config, order_key, is_computed)
     VALUES ($1, $2, $3, $4, $5, 'Main', 'link', '{}', 'b9999', false)`,
    [inverseUuid, ws, baseUuid, peerUuid, peerSlot],
  );
  let nextPeerSlot = peerSlot + 1;
  for (const s of PEER_FIELD_SPECS) {
    await pool.query(
      `INSERT INTO data.fields (id, workspace_id, base_id, table_id, slot, name, type, config, order_key, is_computed)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)`,
      [peerFieldUuids.get(s.key), ws, baseUuid, peerUuid, nextPeerSlot, s.name, s.type, JSON.stringify(s.config), `c${String(nextPeerSlot).padStart(4, "0")}`],
    );
    nextPeerSlot++;
  }
  await pool.query(`UPDATE data.tables SET next_field_slot = $2 WHERE id = $1`, [peerUuid, nextPeerSlot]);
  const relId = generateUuidV7();
  await pool.query(
    `INSERT INTO data.link_relations (id, workspace_id, base_id, a_table_id, a_field_id, b_table_id, b_field_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [relId, ws, baseUuid, tableUuid, linkFieldUuid, peerUuid, inverseUuid],
  );

  // Peer records.
  const peerNames = ["apple", "Banana", "cherry", "date", ""];
  const peerRecordUuids: string[] = [];
  for (let i = 0; i < peerNames.length; i++) {
    const id = generateUuidV7();
    peerRecordUuids.push(id);
    await pool.query(
      `INSERT INTO data.records (table_id, id, workspace_id, base_id, row_number, manual_order, cells, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [peerUuid, id, ws, baseUuid, i + 1, `a${i}`, JSON.stringify(peerNames[i] ? { [peerPrim.slot]: peerNames[i] } : {}), userUuid],
    );
  }

  // Attachments.
  const attUuids: string[] = [];
  for (const [fn, mime] of [["a.png", "image/png"], ["b.pdf", "application/pdf"]] as const) {
    const id = generateUuidV7();
    attUuids.push(id);
    await pool.query(
      `INSERT INTO data.attachments (id, workspace_id, base_id, filename, mime, size_bytes, object_key, scan_status, created_by)
       VALUES ($1, $2, $3, $4, $5, 1234, $6, 'clean', $7)`,
      [id, ws, baseUuid, fn, mime, `test/${id}/${fn}`, userUuid],
    );
  }

  // Main records.
  const r = rng(seed);
  const pick = <T>(xs: T[]): T => xs[Math.floor(r() * xs.length)] as T;
  const maybe = <T>(v: T, p = 0.75): T | undefined => (r() < p ? v : undefined);
  const words = ["alpha", "Beta", "gamma ray", "Delta", "eps", "Alpha beta", "zeta", "", "  spaced  "];
  const recordUuids: string[] = [];
  const ghostUuid = generateUuidV7();
  const today = new Date();
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const dayOffset = (n: number) => iso(new Date(today.getTime() + n * 86400000));
  for (let i = 0; i < nRecords; i++) {
    const id = generateUuidV7();
    recordUuids.push(id);
    const cells: Record<string, unknown> = {};
    const computed: Record<string, unknown> = {};
    const set = (k: string, v: unknown) => {
      if (v !== undefined) cells[String(fields[k]!.slot)] = v;
    };
    set("name", maybe(`${pick(words)} ${i % 7}`, 0.9));
    set("notes", maybe(pick(words)));
    set("email", maybe(`user${i % 5}@example.com`));
    set("num", maybe(pick<unknown>([1, 2, 2.5, -3, 10, 100, 0, "7", "junk", 9, 1e3])));
    set("price", maybe(pick<unknown>(["12.50", 5, 99.99, 0, "abc"])));
    set("pct", maybe(pick([0.1, 0.25, 0.5, 1])));
    set("rate", maybe(pick([1, 2, 3, 4, 5])));
    set("dur", maybe(pick([60, 3600, 5400, 0])));
    set("done", maybe(pick<unknown>([true, true, false, "true"])));
    set("day", maybe(pick<unknown>([dayOffset(0), dayOffset(-1), dayOffset(1), dayOffset(-8), dayOffset(6), dayOffset(-40), dayOffset(40), "2020-02-29", "not a date", "2024-01-05T23:30:00Z"])));
    set("when", maybe(pick<unknown>([
      new Date(today.getTime() - 3600_000).toISOString(),
      new Date(today.getTime() - 86400_000 * 3).toISOString(),
      new Date(today.getTime() + 86400_000 * 2).toISOString(),
      "2024-03-10T03:30:00.000Z",
      "2024-02-30T10:00:00Z",
      "garbage",
    ])));
    set("status", maybe(pick<unknown>(["opt_a", "opt_b", "opt_c", "Beta" /* legacy label */])));
    set("tags", maybe(pick<unknown>([["opt_x"], ["opt_x", "opt_y"], ["opt_z"], ["opt_y", "opt_z", "opt_x"], [], ["Zulu"]])));
    set("owner", maybe(pick<unknown>([[userUuid], [otherUserUuid], [userUuid, otherUserUuid], []])));
    set("files", maybe(pick<unknown>([[attUuids[0]], [attUuids[0], attUuids[1]], []])));
    set("code", maybe(pick<unknown>([{ text: "ABC-123" }, { text: "xyz" }, "LEGACY9"])));
    const fnum = pick<unknown>([3, 4.5, -1, { value: 8, status: "ok" }, { value: null, status: "error", error: "bad" }, undefined]);
    if (fnum !== undefined) computed[String(fields["fnum"]!.slot)] = fnum;
    const ftext = pick<unknown>(["hello", "World", 42, 7, true, undefined]);
    if (ftext !== undefined) computed[String(fields["ftext"]!.slot)] = ftext;
    if (r() < 0.1) computed["_errors"] = { [String(fields["fnum"]!.slot)]: "#ERROR! division by zero" };
    // Lookups store the target's stored values: option ids, user / attachment / record uuids (some dangling).
    const lset = (k: string, v: unknown) => {
      if (v !== undefined) computed[String(fields[k]!.slot)] = v;
    };
    const earlier = () => recordUuids[Math.floor(r() * recordUuids.length)]!;
    lset("lstatus", maybe(pick<unknown>([["opt_p1"], ["opt_p2", "opt_p1"], ["opt_p2"], ["opt_gone"]])));
    lset("lowner", maybe(pick<unknown>([[userUuid], [otherUserUuid, userUuid], [ghostUuid], [ghostUuid, otherUserUuid]])));
    lset("lfiles", maybe(pick<unknown>([[attUuids[0]], [attUuids[1], attUuids[0]], [ghostUuid]])));
    lset("lmain", maybe(pick<unknown>([[earlier()], [earlier(), earlier()], [ghostUuid], [ghostUuid, earlier()]])));
    const creator = r() < 0.7 ? userUuid : otherUserUuid;
    const updater = r() < 0.5 ? null : r() < 0.5 ? userUuid : otherUserUuid;
    await pool.query(
      `INSERT INTO data.records (table_id, id, workspace_id, base_id, row_number, manual_order, cells, computed, created_by, updated_by, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now() - ($11 || ' hours')::interval, now() - ($12 || ' hours')::interval)`,
      [tableUuid, id, ws, baseUuid, i + 1, `a${String(i).padStart(4, "0")}`, JSON.stringify(cells), JSON.stringify(computed), creator, updater, String(Math.floor(r() * 2000)), String(Math.floor(r() * 100))],
    );
    // links (ordered)
    const nLinks = Math.floor(r() * 4);
    const chosen = [...peerRecordUuids].sort(() => r() - 0.5).slice(0, nLinks);
    const lookVals: unknown[] = [];
    for (let j = 0; j < chosen.length; j++) {
      await pool.query(
        `INSERT INTO data.record_links (relation_id, a_record_id, b_record_id, a_order, b_order, workspace_id, base_id)
         VALUES ($1, $2, $3, $4, 'a0', $5, $6)`,
        [relId, id, chosen[j], `a${j}`, ws, baseUuid],
      );
      const nm = peerNames[peerRecordUuids.indexOf(chosen[j]!)];
      if (nm) lookVals.push(nm);
    }
    if (lookVals.length) {
      await pool.query(`UPDATE data.records SET computed = computed || $3::jsonb WHERE table_id = $1 AND id = $2`, [
        tableUuid,
        id,
        JSON.stringify({ [String(fields["look"]!.slot)]: lookVals }),
      ]);
    }
  }
  await pool.query(`UPDATE data.tables SET record_count = $2::bigint, next_row_number = $2::bigint + 1 WHERE id = $1`, [tableUuid, nRecords]);

  return {
    api,
    pool,
    baseId,
    tableId: main.id,
    peerTableId: peer.id,
    baseUuid,
    tableUuid,
    peerUuid,
    userId,
    userUuid,
    otherUserUuid,
    fields,
    recordUuids,
    peerRecordUuids,
  };
}
