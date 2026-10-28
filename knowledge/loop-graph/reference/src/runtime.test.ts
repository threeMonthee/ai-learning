import assert from "node:assert/strict";
import test from "node:test";
import {
  requirementGraph,
  vagueTicket,
  withdrawTicket,
} from "./requirement-graph.ts";
import { drive, heartbeat, resume, startRun } from "./runtime.ts";

const budget = { maxTurns: 12, maxUsd: 2 };

test("a checkable ticket retries once, then waits for approval", async () => {
  const graph = requirementGraph();
  const state = startRun({
    id: "REQ-1842",
    graph,
    goal: withdrawTicket.title,
    effort: "medium",
    budget,
    artifacts: { ticket: withdrawTicket },
  });

  await drive(graph, state);

  assert.equal(state.status, "needs_human");
  assert.equal(state.attemptByNode.implement, 2);
  assert.deepEqual(
    state.log.map((edge) => `${edge.from}->${edge.to}:${edge.guard}`),
    [
      "intake->checkable:always",
      "checkable->implement:checks-are-machine",
      "implement->verify:always",
      "verify->implement:retry-while-budget-remains",
      "implement->verify:always",
      "verify->packet:evidence-passed",
      "packet->approve:always",
    ],
  );

  const missing = state.evidence.find((item) => item.summary.includes("audit-event"));
  assert.ok(missing);

  resume(graph, state, { approved: true, note: "证据包里的 409 和审计事件都在" });
  await drive(graph, state);
  assert.equal(state.status, "done");
  assert.ok(state.spent.usd < budget.maxUsd);
  assert.ok(state.spent.turns <= budget.maxTurns);
});

test("a ticket that only a human can judge never reaches implement", async () => {
  const graph = requirementGraph();
  const state = startRun({
    id: "REQ-1900",
    graph,
    goal: vagueTicket.title,
    effort: "low",
    budget,
    artifacts: { ticket: vagueTicket },
  });

  await drive(graph, state);

  assert.equal(state.status, "needs_human");
  assert.equal(state.attemptByNode.implement, undefined);
  assert.equal(state.artifacts.checkable, false);
  assert.deepEqual(state.artifacts.humanOnly, ["feels-better"]);
});

test("rejection is a terminal path with an audit trail", async () => {
  const graph = requirementGraph();
  const state = startRun({
    id: "REQ-1901",
    graph,
    goal: vagueTicket.title,
    effort: "low",
    budget,
    artifacts: { ticket: vagueTicket },
  });
  await drive(graph, state);
  resume(graph, state, { approved: false, note: "验收项改成机器可判定后再跑" });
  await drive(graph, state);
  assert.equal(state.status, "failed");
  assert.equal(state.log.at(-1)?.guard, "human-rejected");
});

test("the outer heartbeat starts one graph per queued ticket", async () => {
  const graph = requirementGraph();
  const { report } = await heartbeat({
    graph,
    budget,
    queue: [
      {
        id: "REQ-1842",
        goal: withdrawTicket.title,
        effort: "medium",
        artifacts: { ticket: withdrawTicket },
      },
      {
        id: "REQ-1900",
        goal: vagueTicket.title,
        effort: "low",
        artifacts: { ticket: vagueTicket },
      },
    ],
  });

  assert.deepEqual(report.ran, ["REQ-1842", "REQ-1900"]);
  assert.deepEqual(report.waiting.sort(), ["REQ-1842", "REQ-1900"]);
  assert.deepEqual(report.finished, []);
  assert.deepEqual(report.failed, []);
});
