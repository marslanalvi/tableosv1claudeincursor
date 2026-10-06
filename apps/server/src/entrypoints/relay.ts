import { loadDotEnvFile } from "./load-env-file.js";
import { loadEnv } from "@tabula/config";
import { createDb } from "@tabula/db";
import {
  createEventBus,
  DOMAIN_EVENTS_TOPIC,
  type DomainEvent,
} from "@tabula/events";
import { createLogger } from "@tabula/observability";
import { sql } from "kysely";
import { connectRedis } from "../lib/redis.js";

const POLL_MS = 500;
const BATCH = 50;

async function main(): Promise<void> {
  loadDotEnvFile();
  const env = loadEnv();
  const log = createLogger({ name: "tabula-relay", role: "relay" });
  const db = createDb(env.DATABASE_URL);
  const redis = await connectRedis(env, log);
  const eventBus = createEventBus(redis);

  log.info("Relay polling data.outbox_events (MVP profile)");

  let running = false;

  /**
   * Publish one batch. Rows are claimed with FOR UPDATE SKIP LOCKED inside a
   * transaction and marked published in the same transaction, so concurrent
   * relays (or a slow tick overlapping the next) never double-publish.
   */
  const publishBatch = async (): Promise<number> => {
    return db.transaction().execute(async (trx) => {
      const rows = await sql<{
        id: string;
        created_at: Date;
        created_at_exact: string;
        org_id: string;
        workspace_id: string;
        base_id: string | null;
        event_type: string;
        aggregate_type: string;
        aggregate_id: string;
        base_seq: string | null;
        actor: unknown;
        payload: unknown;
      }>`
        SELECT id, created_at, created_at::text AS created_at_exact, org_id, workspace_id, base_id, event_type,
               aggregate_type, aggregate_id, base_seq, actor, payload
        FROM data.outbox_events
        WHERE published_at IS NULL
        ORDER BY created_at ASC
        LIMIT ${BATCH}
        FOR UPDATE SKIP LOCKED
      `.execute(trx);

      for (const row of rows.rows) {
        // Keep the real actor recorded by the kernel (user id, via).
        const stored =
          row.actor !== null && typeof row.actor === "object"
            ? (row.actor as { type?: unknown; id?: unknown; via?: unknown })
            : {};
        const actor = {
          type: stored.type === "user" ? "user" : "system",
          id: typeof stored.id === "string" ? stored.id : null,
          via: typeof stored.via === "string" ? stored.via : "relay",
        } as DomainEvent["actor"];
        const event: DomainEvent = {
          id: row.id,
          type: row.event_type,
          schemaVersion: 1,
          occurredAt: new Date(row.created_at).toISOString(),
          tenant: {
            orgId: row.org_id,
            workspaceId: row.workspace_id,
            ...(row.base_id ? { baseId: row.base_id } : {}),
          },
          actor,
          ...(row.base_seq !== null
            ? { baseSeq: Number(row.base_seq) }
            : {}),
          causationDepth: 0,
          data: {
            aggregateType: row.aggregate_type,
            aggregateId: row.aggregate_id,
            ...(row.payload !== null && typeof row.payload === "object"
              ? (row.payload as Record<string, unknown>)
              : {}),
          },
        };

        const key = row.base_id ?? row.workspace_id;
        await eventBus.publish(DOMAIN_EVENTS_TOPIC, key, event);

        await sql`
          UPDATE data.outbox_events
          SET published_at = now()
          WHERE id = ${row.id}
            AND created_at = ${row.created_at_exact}::timestamptz
        `.execute(trx);
      }
      return rows.rows.length;
    });
  };

  const tick = async (): Promise<void> => {
    if (running) return; // overlap guard
    running = true;
    try {
      for (let i = 0; i < 20; i++) {
        const n = await publishBatch();
        if (n < BATCH) break;
      }
    } catch (err) {
      log.error({ err }, "Relay poll failed");
    } finally {
      running = false;
    }
  };

  await tick();
  setInterval(() => {
    void tick();
  }, POLL_MS);
}

void main();
