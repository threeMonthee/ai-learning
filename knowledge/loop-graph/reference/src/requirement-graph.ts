import type { Graph, HumanDecision, RunState } from "./types.ts";

export interface AcceptanceCheck {
  id: string;
  kind: "machine" | "human";
  detail: string;
}

export interface Ticket {
  title: string;
  body: string;
  checks: AcceptanceCheck[];
}

export interface Patch {
  summary: string;
  files: string[];
  satisfied: string[];
}

const IMPLEMENT_ATTEMPTS = 2;

export function requirementGraph(): Graph {
  return {
    id: "requirement-change",
    start: "intake",
    nodes: [
      {
        id: "intake",
        kind: "agent",
        title: "把工单收成可检查的验收项",
        maxEntries: 1,
        run: (state) => {
          const ticket = readTicket(state);
          return {
            usd: 0.02,
            artifacts: { checks: ticket.checks },
            evidence: {
              ok: ticket.checks.length > 0,
              summary: `收成 ${ticket.checks.length} 条验收项`,
            },
          };
        },
      },
      {
        id: "checkable",
        kind: "gate",
        title: "验收项必须能被机器判定",
        maxEntries: 1,
        run: (state) => {
          const checks = readChecks(state);
          const humanOnly = checks.filter((check) => check.kind === "human");
          const ok = checks.length > 0 && humanOnly.length === 0;
          return {
            usd: 0,
            artifacts: { checkable: ok, humanOnly: humanOnly.map((c) => c.id) },
            evidence: {
              ok,
              summary: ok
                ? "全部验收项都是机器可判定的"
                : `有 ${humanOnly.length} 条只能靠人判断，先停下来改写`,
            },
          };
        },
      },
      {
        id: "implement",
        kind: "agent",
        title: "按验收项改代码",
        maxEntries: IMPLEMENT_ATTEMPTS,
        run: (state) => {
          const attempt = state.attemptByNode.implement ?? 1;
          const checks = readChecks(state);
          const satisfied =
            attempt >= IMPLEMENT_ATTEMPTS
              ? checks.map((check) => check.id)
              : checks.slice(0, Math.max(0, checks.length - 1)).map((c) => c.id);
          const patch: Patch = {
            summary: `第 ${attempt} 次实现`,
            files: ["src/feature.ts", "src/feature.test.ts"],
            satisfied,
          };
          return {
            usd: 0.15,
            artifacts: { patch },
            evidence: {
              ok: true,
              summary: `${patch.summary}，覆盖 ${satisfied.join(", ") || "无"}`,
            },
          };
        },
      },
      {
        id: "verify",
        kind: "gate",
        title: "对照验收项检查补丁",
        maxEntries: IMPLEMENT_ATTEMPTS,
        run: (state) => {
          const checks = readChecks(state);
          const patch = state.artifacts.patch as Patch | undefined;
          const satisfied = new Set(patch?.satisfied ?? []);
          const missing = checks
            .filter((check) => !satisfied.has(check.id))
            .map((check) => check.id);
          const ok = missing.length === 0;
          return {
            usd: 0,
            artifacts: { verify: { ok, missing } },
            evidence: {
              ok,
              summary: ok
                ? "验收项全部有证据"
                : `缺少 ${missing.join(", ")}`,
            },
          };
        },
      },
      {
        id: "packet",
        kind: "tool",
        title: "生成一眼能批的证据包",
        maxEntries: 2,
        run: (state) => {
          const packet = {
            goal: state.goal,
            patch: state.artifacts.patch,
            evidence: state.evidence.map((item) => ({
              nodeId: item.nodeId,
              ok: item.ok,
              summary: item.summary,
            })),
            spent: state.spent,
          };
          return {
            usd: 0,
            artifacts: { packet },
            evidence: { ok: true, summary: "证据包已生成" },
          };
        },
      },
      {
        id: "approve",
        kind: "human",
        title: "人看证据包后决定",
        maxEntries: 2,
        run: (state) => ({
          usd: 0,
          pause: {
            packet: {
              ask:
                state.artifacts.checkable === false
                  ? "验收项还不能由机器判定。退回重写，或拒绝这张工单"
                  : "按证据包决定能否合入",
              goal: state.goal,
              packet: state.artifacts.packet ?? null,
              checkable: state.artifacts.checkable ?? null,
              failure: state.failure ?? null,
              evidence: state.evidence,
            },
          },
        }),
      },
      {
        id: "done",
        kind: "tool",
        title: "记录完成",
        maxEntries: 1,
        run: () => ({
          usd: 0,
          terminal: "done",
          evidence: { ok: true, summary: "人已批准" },
        }),
      },
      {
        id: "stop",
        kind: "tool",
        title: "记录失败并停住",
        maxEntries: 2,
        run: (state) => ({
          usd: 0,
          terminal: "failed",
          failure: state.failure ?? "停在人工拒绝或无法验证",
          evidence: { ok: false, summary: "运行结束，没有合入" },
        }),
      },
    ],
    edges: [
      { from: "intake", to: "checkable", guard: "always", when: () => true },
      {
        from: "checkable",
        to: "implement",
        guard: "checks-are-machine",
        when: (state) => state.artifacts.checkable === true,
      },
      {
        from: "checkable",
        to: "approve",
        guard: "needs-a-rewritten-ticket",
        when: (state) => state.artifacts.checkable !== true,
      },
      { from: "implement", to: "verify", guard: "always", when: () => true },
      {
        from: "verify",
        to: "packet",
        guard: "evidence-passed",
        when: (state) => readVerify(state).ok,
      },
      {
        from: "verify",
        to: "implement",
        guard: "retry-while-budget-remains",
        when: (state) =>
          !readVerify(state).ok &&
          (state.attemptByNode.implement ?? 0) < IMPLEMENT_ATTEMPTS,
      },
      {
        from: "verify",
        to: "approve",
        guard: "retries-exhausted",
        when: (state) =>
          !readVerify(state).ok &&
          (state.attemptByNode.implement ?? 0) >= IMPLEMENT_ATTEMPTS,
      },
      { from: "packet", to: "approve", guard: "always", when: () => true },
      {
        from: "approve",
        to: "done",
        guard: "human-approved",
        when: (state) => decision(state, "approve")?.approved === true,
      },
      {
        from: "approve",
        to: "stop",
        guard: "human-rejected",
        when: (state) => decision(state, "approve")?.approved === false,
      },
    ],
  };
}

function readTicket(state: RunState): Ticket {
  const ticket = state.artifacts.ticket as Ticket | undefined;
  if (!ticket) throw new Error("missing ticket artifact");
  return ticket;
}

function readChecks(state: RunState): AcceptanceCheck[] {
  return (state.artifacts.checks as AcceptanceCheck[] | undefined) ?? [];
}

function readVerify(state: RunState): { ok: boolean; missing: string[] } {
  return (
    (state.artifacts.verify as { ok: boolean; missing: string[] } | undefined) ?? {
      ok: false,
      missing: ["verify-not-run"],
    }
  );
}

function decision(state: RunState, nodeId: string): HumanDecision | undefined {
  return state.artifacts[`human.${nodeId}`] as HumanDecision | undefined;
}

export const withdrawTicket: Ticket = {
  title: "请假单提交后 30 分钟内可撤回",
  body: "员工提交请假后，30 分钟内可以撤回。超时撤回必须被拒绝，并留下审计记录。",
  checks: [
    {
      id: "reject-after-window",
      kind: "machine",
      detail: "提交超过 30 分钟后调用撤回接口，返回 409",
    },
    {
      id: "audit-event",
      kind: "machine",
      detail: "成功撤回时审计日志出现 withdraw 事件，含操作者和请假单号",
    },
  ],
};

export const vagueTicket: Ticket = {
  title: "把请假体验做好一点",
  body: "最近反馈说请假不好用，整体优化一下。",
  checks: [
    {
      id: "feels-better",
      kind: "human",
      detail: "产品负责人觉得体验更好",
    },
  ],
};
