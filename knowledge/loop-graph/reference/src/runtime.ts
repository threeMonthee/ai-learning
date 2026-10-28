import type {
  Graph,
  GraphNode,
  HumanDecision,
  RunState,
  Transition,
} from "./types.ts";

export interface StartRunInput {
  id: string;
  graph: Graph;
  goal: string;
  effort: RunState["effort"];
  budget: RunState["budget"];
  artifacts?: Record<string, unknown>;
}

export function startRun(input: StartRunInput): RunState {
  return {
    id: input.id,
    goal: input.goal,
    effort: input.effort,
    cursor: input.graph.start,
    status: "running",
    artifacts: { ...(input.artifacts ?? {}) },
    evidence: [],
    attemptByNode: {},
    log: [],
    budget: input.budget,
    spent: { turns: 0, usd: 0 },
  };
}

export async function drive(graph: Graph, state: RunState): Promise<RunState> {
  const seen = new Set<string>();
  while (state.status === "running") {
    const signature = `${state.cursor}:${state.spent.turns}:${state.log.length}`;
    if (seen.has(signature)) {
      state.status = "failed";
      state.failure = `control flow repeated without progress at ${state.cursor}`;
      return state;
    }
    seen.add(signature);
    await step(graph, state);
  }
  return state;
}

export async function step(graph: Graph, state: RunState): Promise<RunState> {
  if (state.status !== "running") return state;

  const node = nodeById(graph, state.cursor);
  const entries = (state.attemptByNode[node.id] ?? 0) + 1;
  state.attemptByNode[node.id] = entries;
  if (node.maxEntries !== undefined && entries > node.maxEntries) {
    state.status = "failed";
    state.failure = `${node.id} exceeded maxEntries ${node.maxEntries}`;
    return state;
  }

  if (state.spent.turns >= state.budget.maxTurns) {
    state.status = "budget_exhausted";
    state.failure = `turn budget ${state.budget.maxTurns} exhausted before ${node.id}`;
    return state;
  }

  const result = await node.run(state);
  state.spent.turns += 1;
  state.spent.usd = roundUsd(state.spent.usd + (result.usd ?? 0));
  if (state.spent.usd > state.budget.maxUsd) {
    state.status = "budget_exhausted";
    state.failure = `usd budget ${state.budget.maxUsd} exhausted at ${node.id}`;
    return state;
  }

  if (result.artifacts) {
    state.artifacts = { ...state.artifacts, ...result.artifacts };
  }
  if (result.evidence) {
    state.evidence.push({ nodeId: node.id, ...result.evidence });
  }
  if (result.failure) state.failure = result.failure;

  if (result.pause) {
    state.status = "needs_human";
    state.pendingHuman = { nodeId: node.id, packet: result.pause.packet };
    return state;
  }

  if (result.terminal === "done") {
    state.status = "done";
    return state;
  }
  if (result.terminal === "failed") {
    state.status = "failed";
    return state;
  }

  const edge = graph.edges.find(
    (candidate) => candidate.from === node.id && candidate.when(state),
  );
  if (!edge) {
    state.status = "failed";
    state.failure = `no edge from ${node.id}`;
    return state;
  }
  const transition: Transition = {
    from: node.id,
    to: edge.to,
    guard: edge.guard,
  };
  state.log.push(transition);
  state.cursor = edge.to;
  return state;
}

export function resume(
  graph: Graph,
  state: RunState,
  decision: HumanDecision,
): RunState {
  if (state.status !== "needs_human" || !state.pendingHuman) {
    throw new Error(`run ${state.id} is not waiting for a human`);
  }
  const nodeId = state.pendingHuman.nodeId;
  state.artifacts = {
    ...state.artifacts,
    [`human.${nodeId}`]: decision,
  };
  state.evidence.push({
    nodeId,
    ok: decision.approved,
    summary: decision.note,
  });
  state.pendingHuman = undefined;

  const edge = graph.edges.find(
    (candidate) => candidate.from === nodeId && candidate.when(state),
  );
  if (!edge) {
    state.status = "failed";
    state.failure = `no edge from human node ${nodeId}`;
    return state;
  }
  state.log.push({ from: nodeId, to: edge.to, guard: edge.guard });
  state.cursor = edge.to;
  state.status = "running";
  return state;
}

export function nodeById(graph: Graph, id: string): GraphNode {
  const node = graph.nodes.find((candidate) => candidate.id === id);
  if (!node) throw new Error(`unknown node ${id} in graph ${graph.id}`);
  return node;
}

function roundUsd(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export interface QueueItem {
  id: string;
  goal: string;
  effort: RunState["effort"];
  artifacts: Record<string, unknown>;
}

export interface LoopReport {
  ran: string[];
  waiting: string[];
  finished: string[];
  failed: string[];
}

/**
 * Outer loop: a heartbeat that finds work and starts one graph run per item.
 * It does not decide the path inside a run. That path is the graph.
 */
export async function heartbeat(input: {
  graph: Graph;
  queue: QueueItem[];
  budget: RunState["budget"];
  runs?: Map<string, RunState>;
}): Promise<{ runs: Map<string, RunState>; report: LoopReport }> {
  const runs = input.runs ?? new Map<string, RunState>();
  const report: LoopReport = { ran: [], waiting: [], finished: [], failed: [] };

  for (const item of input.queue) {
    if (runs.has(item.id)) continue;
    const state = startRun({
      id: item.id,
      graph: input.graph,
      goal: item.goal,
      effort: item.effort,
      budget: input.budget,
      artifacts: item.artifacts,
    });
    await drive(input.graph, state);
    runs.set(item.id, state);
    report.ran.push(item.id);
  }

  for (const [id, state] of runs) {
    if (state.status === "needs_human") report.waiting.push(id);
    else if (state.status === "done") report.finished.push(id);
    else if (state.status === "running") report.ran.push(id);
    else report.failed.push(id);
  }
  return { runs, report };
}
