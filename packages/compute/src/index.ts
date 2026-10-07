export * from "./types.js";
export { COMPUTE_SYNC_FANOUT_LIMIT } from "./constants.js";
export { buildFieldGraph, type FieldDependencyGraph } from "./graph.js";
export { detectCycles, type CycleDetectionResult } from "./cycles.js";
export { topoOrder } from "./topo.js";
export { planPropagation, planRecompute, findCycle, type PropagationPlan } from "./propagation.js";
