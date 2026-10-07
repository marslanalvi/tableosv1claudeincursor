import type { FieldDependencyGraph } from "./graph.js";
import { topoOrder } from "./topo.js";

export interface PropagationPlan {
  /** Field ids to recompute, in safe dependency order. */
  fieldIds: string[];
  /** Estimated record touch count (caller supplies fan-out estimate). */
  estimatedFanOut: number;
}

/**
 * Plan which computed fields must refresh when the given source fields changed.
 */
export function planPropagation(
  graph: FieldDependencyGraph,
  changedFieldIds: string[],
): PropagationPlan {
  const changed = new Set(changedFieldIds);
  const affected = new Set<string>();

  const queue = [...changed];
  while (queue.length > 0) {
    const source = queue.shift()!;
    for (const dependent of graph.adjacency.get(source) ?? []) {
      if (!affected.has(dependent)) {
        affected.add(dependent);
        queue.push(dependent);
      }
    }
  }

  const subgraphNodes = [...affected].sort();
  const subgraph: FieldDependencyGraph = {
    nodes: subgraphNodes.map((fieldId) => ({ fieldId })),
    adjacency: new Map(
      subgraphNodes.map((id) => [
        id,
        (graph.adjacency.get(id) ?? []).filter((t) => affected.has(t)),
      ]),
    ),
    edges: graph.edges.filter(
      (e) => affected.has(e.dependentFieldId) && affected.has(e.dependsOnFieldId),
    ),
  };

  const ordered = topoOrder(subgraph).filter((id) => affected.has(id));

  return {
    fieldIds: ordered,
    estimatedFanOut: ordered.length,
  };
}

/**
 * Like `planPropagation`, but `seedFieldIds` are recomputed themselves (and
 * everything downstream of them), in addition to the dependents of
 * `changedFieldIds`. Returns fields in dependency order.
 */
export function planRecompute(
  graph: FieldDependencyGraph,
  changedFieldIds: readonly string[],
  seedFieldIds: readonly string[] = [],
): string[] {
  const affected = new Set<string>(seedFieldIds);
  const queue = [...changedFieldIds, ...seedFieldIds];
  const seenSource = new Set<string>();
  while (queue.length > 0) {
    const source = queue.shift()!;
    if (seenSource.has(source)) continue;
    seenSource.add(source);
    for (const dependent of graph.adjacency.get(source) ?? []) {
      if (!affected.has(dependent)) affected.add(dependent);
      queue.push(dependent);
    }
  }
  const nodes = [...affected].sort();
  const subgraph: FieldDependencyGraph = {
    nodes: nodes.map((fieldId) => ({ fieldId })),
    adjacency: new Map(
      nodes.map((id) => [id, (graph.adjacency.get(id) ?? []).filter((t) => affected.has(t))]),
    ),
    edges: [],
  };
  const ordered = topoOrder(subgraph);
  // Nodes in a cycle never reach in-degree 0; append them so nothing is lost.
  for (const id of nodes) if (!ordered.includes(id)) ordered.push(id);
  return ordered;
}

/**
 * Return a cycle path (field ids, first === last) that `edges` would form, or
 * null. Only cycles passing through `focusFieldIds` are reported when given.
 */
export function findCycle(
  fieldIds: readonly string[],
  edges: ReadonlyArray<{ dependentFieldId: string; dependsOnFieldId: string }>,
): string[] | null {
  const adj = new Map<string, string[]>();
  for (const id of fieldIds) adj.set(id, []);
  for (const e of edges) {
    if (!adj.has(e.dependsOnFieldId)) adj.set(e.dependsOnFieldId, []);
    if (!adj.has(e.dependentFieldId)) adj.set(e.dependentFieldId, []);
    adj.get(e.dependsOnFieldId)!.push(e.dependentFieldId);
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const dfs = (n: string): string[] | null => {
    color.set(n, GREY);
    stack.push(n);
    for (const m of adj.get(n) ?? []) {
      const c = color.get(m) ?? WHITE;
      if (c === GREY) {
        const idx = stack.indexOf(m);
        return [...stack.slice(idx), m];
      }
      if (c === WHITE) {
        const r = dfs(m);
        if (r) return r;
      }
    }
    stack.pop();
    color.set(n, BLACK);
    return null;
  };
  for (const n of adj.keys()) {
    if ((color.get(n) ?? WHITE) === WHITE) {
      const r = dfs(n);
      if (r) return r;
    }
  }
  return null;
}
