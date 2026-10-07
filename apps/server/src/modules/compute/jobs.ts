import type { TabulaDb } from "@tabula/db";
import { sql } from "kysely";
import { runComputeInTx } from "./engine.js";

export interface ComputeJobPayload {
  baseId: string;
  workspaceId: string;
}

const BATCH = 2000;

/**
 * Drain `data.computed_stale` for a base (worker handler).
 *
 * The stale (field, record) pairs are recomputed directly (as seeds — the
 * stale fields themselves, not just their dependents) and their downstream
 * dependents are propagated. Exactly the rows processed are deleted, in the
 * same transaction. Fan-out produced while draining is written back to
 * `computed_stale` and picked up by the next loop iteration, so nothing is
 * lost even without a Redis handle here.
 */
export async function handleComputeJob(db: TabulaDb, payload: ComputeJobPayload): Promise<void> {
  for (let iter = 0; iter < 10_000; iter++) {
    const processed = await db.transaction().execute(async (trx) => {
      const stale = await sql<{ table_id: string; record_id: string; field_id: string }>`
        SELECT table_id, record_id, field_id
        FROM data.computed_stale
        WHERE base_id = ${payload.baseId}
        ORDER BY enqueued_at ASC
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      `.execute(trx);
      if (stale.rows.length === 0) return 0;

      const byField = new Map<string, string[]>();
      for (const r of stale.rows) {
        const list = byField.get(r.field_id) ?? [];
        list.push(r.record_id);
        byField.set(r.field_id, list);
      }
      // Delete first: re-deferred fan-out for the same pair re-inserts it.
      const chunk = stale.rows.map((r) => ({ t: r.table_id, r: r.record_id, f: r.field_id }));
      await sql`
        DELETE FROM data.computed_stale s
        USING jsonb_to_recordset(${JSON.stringify(chunk)}::jsonb) AS v(t uuid, r uuid, f uuid)
        WHERE s.table_id = v.t AND s.record_id = v.r AND s.field_id = v.f
      `.execute(trx);

      await runComputeInTx(
        trx,
        { baseId: payload.baseId, workspaceId: payload.workspaceId, redis: null },
        {
          seeds: [...byField].map(([fieldId, recordIds]) => ({ fieldId, recordIds })),
          syncLimit: BATCH,
        },
      );
      return stale.rows.length;
    });
    if (processed === 0) return;
  }
}
