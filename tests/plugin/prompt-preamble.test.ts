import { describe, expect, it } from "vitest";

import { buildTaskRelayPrompt, buildThreadRelayPrompt } from "../support/relay-plugin-testkit.js";

type TestTeamStatus = {
  runId: string;
  roomCode: string;
  task: string;
  status: string;
  managerSessionID: string;
  currentSessionRole: string;
  workers: Array<{
    runId: string;
    sessionID: string;
    role: string;
    alias: string;
    title: string;
    status: string;
    lastNote?: string;
    workflowPhase?: string;
    progress?: number;
    createdAt: number;
    updatedAt: number;
    health: string;
    stale: boolean;
  }>;
  summary: {
    counts: Record<string, number>;
    healthCounts: Record<string, number>;
  };
  recentEvents: unknown[];
  attentionItems: unknown[];
  interventionOutcomes: unknown[];
  policyDecisions: unknown[];
  recommendedActions: Array<{
    action: string;
    targetAlias?: string;
    handoffTo?: string;
    reason: string;
  }>;
  nextStep: string;
};

function createManagerTeamStatus(overrides: Partial<TestTeamStatus> = {}): TestTeamStatus {
  return {
    runId: "run-1",
    roomCode: "030900",
    task: "测试一下",
    status: "completed",
    managerSessionID: "session-manager",
    currentSessionRole: "manager",
    workers: [
      {
        runId: "run-1",
        sessionID: "session-reviewer",
        role: "reviewer",
        alias: "reviewer",
        title: "team/reviewer: 测试一下",
        status: "completed",
        lastNote: "Verdict pass",
        workflowPhase: "signal-review-complete",
        progress: 100,
        createdAt: 1,
        updatedAt: 1,
        health: "settled",
        stale: false
      }
    ],
    summary: { counts: { completed: 1 }, healthCounts: { settled: 1 } },
    recentEvents: [],
    attentionItems: [],
    interventionOutcomes: [],
    policyDecisions: [],
    recommendedActions: [],
    nextStep: "done",
    ...overrides
  };
}

describe("relay prompt preamble", () => {
  it("builds a task relay prompt with fixed agent-awareness preamble", () => {
    const prompt = buildTaskRelayPrompt({
      sourceSessionID: "session-a",
      taskId: "task-1",
      contextId: "ctx-1",
      content: "Implement feature X"
    });

    expect(prompt).toContain("[RELAYED AGENT INPUT]");
    expect(prompt).toContain("Sender: another agent (not a human user)");
    expect(prompt).toContain("Task ID: task-1");
    expect(prompt).toContain("Response mode: use tools/workflow actions, not end-user chat replies");
    expect(prompt).toContain("Implement feature X");
  });

  it("builds a thread relay prompt with room and thread context", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "123456",
      recipientSessionID: "session-b",
      thread: {
        threadId: "thread-1",
        roomCode: "123456",
        kind: "group",
        title: "team-main",
        createdBySessionID: "session-owner",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-1",
          seq: 1,
          messageId: "relaymsg-1",
          senderSessionID: "session-a",
          messageType: "relay",
          body: { text: "hello group" },
          createdAt: 1
        }
      ],
      senderRoles: {
        "session-a": "member"
      }
    });

    expect(prompt).toContain("Thread: thread-1 (group)");
    expect(prompt).toContain("Sender: one or more relay agents (not human users)");
    expect(prompt).toContain("Response mode: use tools/workflow actions, not end-user chat replies");
    expect(prompt).toContain("sender_role=member");
    expect(prompt).toContain("hello group");
  });

  it("uses the old simple private relay prompt for private direct threads", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "654321",
      roomKind: "private",
      recipientSessionID: "session-b",
      thread: {
        threadId: "thread-private",
        roomCode: "654321",
        kind: "direct",
        createdBySessionID: "session-a",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-private",
          seq: 1,
          messageId: "relaymsg-1",
          senderSessionID: "session-a",
          messageType: "relay",
          body: { text: "hello private" },
          createdAt: 1
        }
      ],
      senderRoles: {
        "session-a": "owner"
      }
    });

    expect(prompt).toContain("[RELAYED AGENT INPUT]");
    expect(prompt).toContain("Sender: paired agent session session-a (not a human user)");
    expect(prompt).toContain("Response mode: use tools/workflow actions, not end-user chat replies");
    expect(prompt).toContain("Message:");
    expect(prompt).toContain("hello private");
  });

  it("builds a compact manager summary with worker session links for team rooms", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "030900",
      recipientSessionID: "session-manager",
      thread: {
        threadId: "thread-team",
        roomCode: "030900",
        kind: "group",
        title: "room-main",
        createdBySessionID: "session-manager",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-team",
          seq: 5,
          messageId: "relaymsg-5",
          senderSessionID: "session-reviewer",
          messageType: "relay",
          body: {
            text: '[TEAM_DONE] {"source":"omo","phase":"signal-review-complete","note":"Verdict pass","progress":100,"evidence":["ok"]}'
          },
          createdAt: 1
        }
      ],
      senderRoles: {
        "session-reviewer": "member"
      },
      senderAliases: {
        "session-reviewer": "reviewer"
      },
      managerView: {
        directory: "C:/relay-project",
        workerLinks: [
          { alias: "planner", role: "planner", sessionID: "session-planner" },
          { alias: "implementer", role: "implementer", sessionID: "session-implementer" },
          { alias: "reviewer", role: "reviewer", sessionID: "session-reviewer" }
        ],
        teamStatus: createManagerTeamStatus() as never
      }
    });

    expect(prompt).toContain("[TEAM UPDATE]");
    expect(prompt).toContain("Worker sessions:");
    expect(prompt).toContain("[planner](/QzovcmVsYXktcHJvamVjdA/session/session-planner)");
    expect(prompt).toContain("[implementer](/QzovcmVsYXktcHJvamVjdA/session/session-implementer)");
    expect(prompt).toContain("[reviewer](/QzovcmVsYXktcHJvamVjdA/session/session-reviewer)");
    expect(prompt).toContain("Status:");
    expect(prompt).toContain("- reviewer: done [signal-review-complete · 100%] - Verdict pass");
    expect(prompt).toContain("Action:");
    expect(prompt).toContain("- pass candidate; confirm with relay_team_status, then decide whether to clean up the team");
    expect(prompt).not.toContain("[RELAYED AGENT INPUT]");
  });

  it("collapses multiple updates from the same worker into the latest state and surfaces blockers as actions", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "030900",
      recipientSessionID: "session-manager",
      thread: {
        threadId: "thread-team",
        roomCode: "030900",
        kind: "group",
        title: "room-main",
        createdBySessionID: "session-manager",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [
        {
          threadId: "thread-team",
          seq: 1,
          messageId: "relaymsg-1",
          senderSessionID: "session-planner",
          messageType: "relay",
          body: { text: "planner ready for work" },
          createdAt: 1
        },
        {
          threadId: "thread-team",
          seq: 2,
          messageId: "relaymsg-2",
          senderSessionID: "session-planner",
          messageType: "relay",
          body: { text: '[TEAM_PROGRESS] {"source":"superpowers","phase":"planning","note":"Minimal plan drafted","progress":70}' },
          createdAt: 2
        },
        {
          threadId: "thread-team",
          seq: 3,
          messageId: "relaymsg-3",
          senderSessionID: "session-reviewer",
          messageType: "relay",
          body: { text: '[TEAM_BLOCKER] {"source":"omo","phase":"review-intake","note":"Need a concrete target","progress":20}' },
          createdAt: 3
        }
      ],
      senderRoles: {
        "session-planner": "member",
        "session-reviewer": "member"
      },
      senderAliases: {
        "session-planner": "planner",
        "session-reviewer": "reviewer"
      },
      managerView: {
        directory: "C:/relay-project",
        workerLinks: [
          { alias: "planner", role: "planner", sessionID: "session-planner" },
          { alias: "reviewer", role: "reviewer", sessionID: "session-reviewer" }
        ],
        teamStatus: createManagerTeamStatus({
          status: "blocked",
          workers: [
            {
              runId: "run-1",
              sessionID: "session-planner",
              role: "planner",
              alias: "planner",
              title: "team/planner: 测试一下",
              status: "in_progress",
              lastNote: "Minimal plan drafted",
              workflowPhase: "planning",
              progress: 70,
              createdAt: 1,
              updatedAt: 2,
              health: "active",
              stale: false
            },
            {
              runId: "run-1",
              sessionID: "session-reviewer",
              role: "reviewer",
              alias: "reviewer",
              title: "team/reviewer: 测试一下",
              status: "blocked",
              lastNote: "Need a concrete target",
              workflowPhase: "review-intake",
              progress: 20,
              createdAt: 1,
              updatedAt: 3,
              health: "active",
              stale: false
            }
          ],
          summary: { counts: { in_progress: 1, blocked: 1 }, healthCounts: { active: 2 } },
          recommendedActions: [
            {
              action: "unblock",
              targetAlias: "reviewer",
              reason: "reviewer is blocked: Need a concrete target"
            }
          ]
        }) as never
      }
    });

    expect(prompt).not.toContain("planner ready for work");
    expect(prompt).toContain("Blocking:");
    expect(prompt).toContain("- reviewer: blocked [review-intake · 20%] - Need a concrete target");
    expect(prompt).toContain("- reviewer: Need a concrete target");
  });

  it("normalizes stable blocked phases so repeated blocker updates can be suppressed", () => {
    const prompt = buildThreadRelayPrompt({
      roomCode: "030900",
      recipientSessionID: "session-manager",
      thread: {
        threadId: "thread-team",
        roomCode: "030900",
        kind: "group",
        title: "room-main",
        createdBySessionID: "session-manager",
        createdAt: 1,
        updatedAt: 1
      },
      messages: [],
      senderRoles: {},
      managerView: {
        directory: "C:/relay-project",
        workerLinks: [
          { alias: "reviewer", role: "reviewer", sessionID: "session-reviewer" }
        ],
        teamStatus: createManagerTeamStatus({
          status: "blocked",
          workers: [
            {
              runId: "run-1",
              sessionID: "session-reviewer",
              role: "reviewer",
              alias: "reviewer",
              title: "team/reviewer: 测试一下",
              status: "blocked",
              lastNote: "Still waiting on live evidence",
              workflowPhase: "final-acceptance-waiting-on-live-evidence",
              progress: 85,
              createdAt: 1,
              updatedAt: 4,
              health: "active",
              stale: false
            }
          ],
          summary: { counts: { blocked: 1 }, healthCounts: { active: 1 } },
          recommendedActions: [
            {
              action: "unblock",
              targetAlias: "reviewer",
              reason: "reviewer is blocked: Still waiting on live evidence"
            }
          ]
        }) as never
      }
    });

    expect(prompt).toContain("- reviewer: blocked - Still waiting on live evidence");
    expect(prompt).toContain("- reviewer: Still waiting on live evidence");
    expect(prompt).not.toContain("final-acceptance-waiting-on-live-evidence");
  });
});
