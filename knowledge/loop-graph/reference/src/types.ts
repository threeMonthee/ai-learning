export type Effort = "low" | "medium" | "high";

export type RunStatus =
  | "running"
  | "needs_human"
  | "done"
  | "failed"
  | "budget_exhausted";

export type NodeKind = "agent" | "gate" | "human" | "tool";

export interface Evidence {
  nodeId: string;
  ok: boolean;
  summary: string;
}

export interface Transition {
  from: string;
  to: string;
  guard: string;
}

export interface Budget {
  maxTurns: number;
  maxUsd: number;
}

export interface Spend {
  turns: number;
  usd: number;
}

export interface RunState {
  id: string;
  goal: string;
  effort: Effort;
  cursor: string;
  status: RunStatus;
  artifacts: Record<string, unknown>;
  evidence: Evidence[];
  attemptByNode: Record<string, number>;
  log: Transition[];
  budget: Budget;
  spent: Spend;
  pendingHuman?: { nodeId: string; packet: unknown };
  failure?: string;
}

export interface NodeResult {
  artifacts?: Record<string, unknown>;
  evidence?: Omit<Evidence, "nodeId">;
  usd?: number;
  pause?: { packet: unknown };
  terminal?: "done" | "failed";
  failure?: string;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  title: string;
  /** Re-entries above this count are a bug in the graph, not a retry policy. */
  maxEntries?: number;
  run: (state: RunState) => NodeResult | Promise<NodeResult>;
}

export interface GraphEdge {
  from: string;
  to: string;
  /** Human-readable name of the condition. First matching edge wins. */
  guard: string;
  when: (state: RunState) => boolean;
}

export interface Graph {
  id: string;
  start: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface HumanDecision {
  approved: boolean;
  note: string;
}
