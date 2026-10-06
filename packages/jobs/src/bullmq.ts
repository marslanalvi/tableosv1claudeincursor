import { Queue, Worker, type Processor, type WorkerOptions } from "bullmq";
import type { Redis } from "ioredis";

import type { QueueName } from "./queues.js";

/**
 * Queues are cached per (connection, name): callers may call `createQueue` on
 * every request without leaking a duplicated Redis connection each time.
 * All queues created from one base connection share a single duplicate.
 * Do not `close()` a cached queue; use `closeAllQueues()` at shutdown.
 */
const queueCache = new WeakMap<Redis, { shared: Redis; queues: Map<string, Queue> }>();
const allCaches = new Set<{ shared: Redis; queues: Map<string, Queue> }>();

export function createQueue(
  name: QueueName | string,
  connection: Redis,
): Queue {
  let entry = queueCache.get(connection);
  if (!entry) {
    entry = { shared: connection.duplicate(), queues: new Map() };
    queueCache.set(connection, entry);
    allCaches.add(entry);
  }
  let queue = entry.queues.get(name);
  if (!queue) {
    queue = new Queue(name, { connection: entry.shared });
    entry.queues.set(name, queue);
  }
  return queue;
}

/** Alias that makes the singleton semantics explicit. */
export const getQueue = createQueue;

export async function closeAllQueues(): Promise<void> {
  for (const entry of allCaches) {
    await Promise.all([...entry.queues.values()].map((q) => q.close()));
    entry.queues.clear();
    entry.shared.disconnect();
  }
  allCaches.clear();
}

export function createWorker(
  name: QueueName | string,
  processor: Processor,
  connection: Redis,
  options?: Omit<WorkerOptions, "connection">,
): Worker {
  return new Worker(name, processor, {
    ...options,
    connection: connection.duplicate(),
  });
}
