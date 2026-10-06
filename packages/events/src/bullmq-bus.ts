import { Queue, Worker } from "bullmq";
import type { Redis } from "ioredis";

import type { EventBus } from "./bus.js";
import type { DomainEvent } from "./envelope.js";

/** BullMQ queue names may not contain ':' — keep to a safe charset. */
function safe(part: string): string {
  return part.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** One queue per (topic, consumer group): every group sees every event. */
export function queueNameForGroup(topic: string, group: string): string {
  return `evt__${safe(topic)}__${safe(group)}`;
}

/** Redis set listing the consumer groups registered for a topic. */
function groupsKey(topic: string): string {
  return `tabula:evt-groups:${topic}`;
}

/**
 * Fan-out event bus on BullMQ.
 *
 * `subscribe(topic, group)` registers the group in a Redis set and starts a
 * worker on that group's own queue. `publish` adds the event to the queue of
 * every registered group, so independent consumers (search indexer,
 * notifications, automations…) each receive every event, while multiple
 * processes of the *same* group still share work. Jobs use the event id as
 * job id so a re-published outbox row is not processed twice.
 */
export class BullMQEventBus implements EventBus {
  private readonly queues = new Map<string, Queue>();
  private readonly workers: Worker[] = [];
  private groupCache = new Map<string, { groups: string[]; at: number }>();
  private queueConnection: Redis | null = null;

  constructor(private readonly connection: Redis) {}

  private getQueue(name: string): Queue {
    let queue = this.queues.get(name);
    if (!queue) {
      // Share one connection across all queues of this bus (no per-call leak).
      this.queueConnection ??= this.connection.duplicate();
      queue = new Queue(name, { connection: this.queueConnection });
      this.queues.set(name, queue);
    }
    return queue;
  }

  private async groupsFor(topic: string): Promise<string[]> {
    const cached = this.groupCache.get(topic);
    if (cached && Date.now() - cached.at < 5_000) return cached.groups;
    const groups = await this.connection.smembers(groupsKey(topic));
    this.groupCache.set(topic, { groups, at: Date.now() });
    return groups;
  }

  async publish(
    topic: string,
    key: string,
    event: DomainEvent,
  ): Promise<void> {
    const groups = await this.groupsFor(topic);
    await Promise.all(
      groups.map((group) =>
        this.getQueue(queueNameForGroup(topic, group)).add(key, event, {
          jobId: safe(event.id),
          removeOnComplete: 1000,
          removeOnFail: 5000,
        }),
      ),
    );
  }

  async subscribe(
    topic: string,
    group: string,
    handler: (event: DomainEvent) => Promise<void>,
  ): Promise<void> {
    await this.connection.sadd(groupsKey(topic), group);
    this.groupCache.delete(topic);
    const worker = new Worker(
      queueNameForGroup(topic, group),
      async (job) => {
        await handler(job.data as DomainEvent);
      },
      {
        connection: this.connection.duplicate(),
        name: group,
      },
    );
    this.workers.push(worker);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    this.workers.length = 0;
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
    this.queues.clear();
    this.queueConnection?.disconnect();
    this.queueConnection = null;
  }
}
