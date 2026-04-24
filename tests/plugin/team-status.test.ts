import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(
  projectID = "project-team-status",
  promptAsync = vi.fn().mockResolvedValue({ data: undefined }),
  create = vi.fn()
    .mockResolvedValueOnce({ data: { id: "session-planner", title: "team/planner: ship team workflow" } })
    .mockResolvedValueOnce({ data: { id: "session-implementer", title: "team/implementer: ship team workflow" } })
    .mockResolvedValueOnce({ data: { id: "session-reviewer", title: "team/reviewer: ship team workflow" } })
): PluginInput {
  return {
    client: {
      session: {
        prompt: vi.fn().mockResolvedValue({ data: true }),
        promptAsync,
        create
      }
    } as unknown as PluginInput["client"],
    project: {
      id: projectID,
      worktree: "C:/relay-project",
      time: { created: Date.now() }
    } as PluginInput["project"],
    directory: "C:/relay-project",
    worktree: "C:/relay-project",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"]
  };
}

afterEach(async () => {
  await stopRelayPlugin("project-team-status");
  await stopRelayPlugin("project-team-status-failure");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("relay team status tool", () => {
  it("tracks worker bootstrap, join, ready, and completed workflow states", async () => {
    const databasePath = createTestDatabaseLocation("team-status-ready");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-team-status", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string; runId: string };

    const initialStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { status: string; workers: Array<{ status: string }> };

    expect(initialStatus.status).toBe("waiting");
    expect(initialStatus.workers.every((worker) => worker.status === "bootstrapped")).toBe(true);

    for (const [sessionID, alias] of [["session-planner", "planner"], ["session-implementer", "implementer"], ["session-reviewer", "reviewer"]] as const) {
      await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias }, {
        sessionID,
        messageID: `${sessionID}-join`,
        agent: "build",
        directory: "C:/relay-project",
        worktree: "C:/relay-project",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {}
      });

      await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: `[TEAM_READY] {"source":"openspec","phase":"join","note":"${alias} ready"}` }, {
        sessionID,
        messageID: `${sessionID}-ready`,
        agent: "build",
        directory: "C:/relay-project",
        worktree: "C:/relay-project",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {}
      });
    }

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"source\":\"openspec\",\"phase\":\"tasks\",\"note\":\"planner drafted task artifacts\",\"progress\":35,\"evidence\":[\"proposal.md\",\"tasks.md\"]}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-progress",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"omo\",\"phase\":\"review\",\"note\":\"reviewer signed off\",\"evidence\":[\"review-checklist\"],\"handoffTo\":\"manager\",\"deliverables\":[\"review-checklist\"]}" }, {
      sessionID: "session-reviewer",
      messageID: "session-reviewer-done",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      status: string;
      currentSessionRole: string;
      summary: { counts: Record<string, number>; healthCounts: Record<string, number> };
      workers: Array<{ role: string; status: string; health: string; lastNote?: string; workflowSource?: string; workflowPhase?: string; progress?: number; evidence?: unknown }>;
      recentEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
      attentionItems: Array<{ kind: string; severity: string; targetAlias?: string; count?: number; reason: string; suggestedAction: string }>;
      policyDecisions: Array<{ mode: string; action?: string; targetAlias?: string; severity: string; reason: string; requiresExplicitApply: boolean; sourceKind: string }>;
      recommendedActions: Array<{ action: string; targetAlias?: string; handoffTo?: string; reason: string }>;
      nextStep: string;
    };

    expect(managerStatus.currentSessionRole).toBe("manager");
    expect(managerStatus.status).toBe("in_progress");
    expect(managerStatus.summary.counts.ready).toBe(1);
    expect(managerStatus.summary.counts.in_progress).toBe(1);
    expect(managerStatus.summary.counts.completed).toBe(1);
    expect(managerStatus.summary.healthCounts.settled).toBe(1);
    expect(managerStatus.workers.find((worker) => worker.role === "reviewer")?.lastNote).toContain("reviewer signed off");
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.workflowSource).toBe("openspec");
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.workflowPhase).toBe("tasks");
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.progress).toBe(35);
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.evidence).toEqual(["proposal.md", "tasks.md"]);
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.status).toBe("in_progress");
    expect(managerStatus.workers.find((worker) => worker.role === "reviewer")?.workflowSource).toBe("omo");
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.health).toBe("unknown");
    expect(managerStatus.recentEvents.some((event) => event.eventType === "team.worker.in_progress" && event.payload.source === "openspec")).toBe(true);
    expect(managerStatus.recentEvents.some((event) => event.eventType === "team.worker.completed" && (event.payload.metadata as { handoffTo?: string } | undefined)?.handoffTo === "manager")).toBe(true);
    expect(managerStatus.attentionItems).toEqual([]);
    expect(managerStatus.policyDecisions).toEqual([]);
    expect(managerStatus.recommendedActions).toEqual([]);
    expect(managerStatus.nextStep).toContain("in progress");

    const compactionOutput = { context: [] as string[] };
    await hooks["experimental.session.compacting"]?.({ sessionID: "session-manager" }, compactionOutput);
    expect(compactionOutput.context.join("\n")).toContain("## Team Workflow");
    expect(compactionOutput.context.join("\n")).toContain(started.roomCode);

    const state = getRelayPluginStateForTest("project-team-status")!;
    expect(state.runtime.teamStore.getRun(started.runId)?.status).toBe("in_progress");
  }, 15000);

  it("requires reviewer final acceptance before marking the run completed", async () => {
    const databasePath = createTestDatabaseLocation("team-status-acceptance-gate");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m-acceptance-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string; runId: string };

    for (const [sessionID, alias] of [["session-planner", "planner"], ["session-implementer", "implementer"], ["session-reviewer", "reviewer"]] as const) {
      await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias }, {
        sessionID,
        messageID: `${sessionID}-join-acceptance`,
        agent: "build",
        directory: "C:/relay-project",
        worktree: "C:/relay-project",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {}
      });

      await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: `[TEAM_READY] {"source":"openspec","phase":"join","note":"${alias} ready"}` }, {
        sessionID,
        messageID: `${sessionID}-ready-acceptance`,
        agent: "build",
        directory: "C:/relay-project",
        worktree: "C:/relay-project",
        abort: new AbortController().signal,
        metadata: () => {},
        ask: async () => {}
      });
    }

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"openspec\",\"phase\":\"planning-complete\",\"note\":\"planner handed off tasks\",\"evidence\":[\"tasks.md\"],\"handoffTo\":\"implementer\",\"deliverables\":[\"tasks.md\"]}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-done-acceptance",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"omo\",\"phase\":\"cleanup-complete\",\"note\":\"implementer cleaned up\",\"evidence\":[\"cleanup.log\"],\"handoffTo\":\"reviewer\",\"deliverables\":[\"cleanup.log\"]}" }, {
      sessionID: "session-implementer",
      messageID: "session-implementer-done-acceptance",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"omo\",\"phase\":\"review-standby\",\"note\":\"reviewer is waiting to issue the final acceptance\",\"evidence\":[\"review-checklist\"],\"handoffTo\":\"manager\",\"deliverables\":[\"review-checklist\"]}" }, {
      sessionID: "session-reviewer",
      messageID: "session-reviewer-standby-acceptance",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const preAcceptance = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m-acceptance-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { status: string; workers: Array<{ role: string; workflowPhase?: string }>; summary: { counts: Record<string, number> } };

    expect(preAcceptance.status).toBe("in_progress");
    expect(preAcceptance.summary.counts.completed).toBe(3);
    expect(preAcceptance.workers.find((worker) => worker.role === "reviewer")?.workflowPhase).toBe("review-standby");

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"omo\",\"phase\":\"final-acceptance-pass\",\"note\":\"reviewer final acceptance passed\",\"evidence\":[\"acceptance-report\"],\"handoffTo\":\"manager\",\"deliverables\":[\"acceptance-report\"]}" }, {
      sessionID: "session-reviewer",
      messageID: "session-reviewer-final-acceptance",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const postAcceptance = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m-acceptance-3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { status: string; summary: { counts: Record<string, number> } };

    expect(postAcceptance.status).toBe("completed");
    expect(postAcceptance.summary.counts.completed).toBe(3);

    const state = getRelayPluginStateForTest("project-team-status")!;
    expect(state.runtime.teamStore.getRun(started.runId)?.status).toBe("completed");
  });

  it("does not treat plain relay room chatter as a ready signal", async () => {
    const databasePath = createTestDatabaseLocation("team-status-plain-chat");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "plain hello without workflow marker" }, {
      sessionID: "session-planner",
      messageID: "session-planner-chat",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { workers: Array<{ role: string; status: string; health: string }> };

    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.status).toBe("joined");
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.health).toBe("unknown");
  });

  it("rejects low-quality TEAM_PROGRESS signals without advancing worker state", async () => {
    const databasePath = createTestDatabaseLocation("team-status-invalid-progress");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_READY] {\"source\":\"openspec\",\"phase\":\"join\",\"note\":\"planner ready\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-ready",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"note\":\"working but missing source and phase\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-progress",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      workers: Array<{ role: string; status: string; lastNote?: string }>;
      recentEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
      attentionItems: Array<{ kind: string; severity: string; targetAlias?: string; count?: number; reason: string; suggestedAction: string }>;
      policyDecisions: Array<{ mode: string; action?: string; targetAlias?: string; severity: string; reason: string; requiresExplicitApply: boolean; sourceKind: string }>;
      recommendedActions: Array<{ action: string; targetAlias?: string; reason: string }>;
    };

    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.status).toBe("ready");
    expect(managerStatus.workers.find((worker) => worker.role === "planner")?.lastNote).toBe("planner ready");
    expect(managerStatus.recentEvents.some((event) => event.eventType === "team.worker.signal_rejected" && event.payload.rejectionReason === "[TEAM_PROGRESS] requires source")).toBe(true);
    expect(managerStatus.attentionItems.some((item) => item.kind === "rejected_signal" && item.targetAlias === "planner" && item.suggestedAction === "retry")).toBe(true);
    expect(managerStatus.policyDecisions.some((decision) => decision.mode === "manual_intervention" && decision.action === "retry" && decision.targetAlias === "planner" && decision.sourceKind === "rejected_signal")).toBe(true);
    expect(managerStatus.recommendedActions.some((action) => action.action === "retry" && action.targetAlias === "planner")).toBe(true);
  });

  it("escalates repeated rejected TEAM signals after manager intervention", async () => {
    const databasePath = createTestDatabaseLocation("team-status-rejected-escalation");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_READY] {\"source\":\"openspec\",\"phase\":\"join\",\"note\":\"planner ready\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-ready",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"note\":\"bad signal 1\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-progress-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_team_intervene.execute({
      roomCode: started.roomCode,
      action: "retry",
      targetAlias: "planner",
      note: "resend with valid source/phase"
    }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"note\":\"bad signal 2\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-progress-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      attentionItems: Array<{ kind: string; severity: string; targetAlias?: string; count?: number; reason: string; suggestedAction: string }>;
      policyDecisions: Array<{ mode: string; action?: string; targetAlias?: string; severity: string; reason: string; requiresExplicitApply: boolean; sourceKind: string }>;
      recommendedActions: Array<{ action: string; targetAlias?: string; reason: string }>;
    };

    expect(managerStatus.attentionItems.some((item) => item.kind === "escalated_issue" && item.targetAlias === "planner" && item.suggestedAction === "reassign" && item.count === 2)).toBe(true);
    expect(managerStatus.policyDecisions.some((decision) => decision.mode === "escalate" && decision.action === "reassign" && decision.targetAlias === "planner" && decision.sourceKind === "escalated_issue" && decision.requiresExplicitApply === false)).toBe(true);
    expect(managerStatus.recommendedActions.some((action) => action.action === "retry" && action.targetAlias === "planner")).toBe(true);
  });

  it("does not expose reassign escalations as directly applyable policies without a handoff target", async () => {
    const databasePath = createTestDatabaseLocation("team-status-apply-policy-reassign");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m-reassign-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join-reassign",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_READY] {\"source\":\"openspec\",\"phase\":\"join\",\"note\":\"planner ready\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-ready-reassign",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"note\":\"bad signal 1\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-progress-reassign-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"note\":\"bad signal 2\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-progress-reassign-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await expect(hooks.tool?.relay_team_apply_policy.execute({
      roomCode: started.roomCode,
      action: "reassign",
      targetAlias: "planner"
    }, {
      sessionID: "session-manager",
      messageID: "m-reassign-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    })).rejects.toThrow(/No applyable policy decision found/);
  });

  it("marks silent workers as stale after the configured timeout window", async () => {
    const databasePath = createTestDatabaseLocation("team-status-stale");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath, teamWorkerStaleAfterMs: 1 }
    });

    await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      summary: { healthCounts: Record<string, number> };
      workers: Array<{ role: string; health: string }>; 
      attentionItems: Array<{ kind: string; severity: string; targetAlias?: string; reason: string; suggestedAction: string }>;
      recommendedActions: Array<{ action: string; targetAlias?: string; reason: string }>;
      nextStep: string;
    };

    expect(managerStatus.summary.healthCounts.stale).toBe(3);
    expect(managerStatus.workers.every((worker) => worker.health === "stale")).toBe(true);
    expect(managerStatus.attentionItems.filter((item) => item.kind === "stale_worker").length).toBe(3);
    expect(managerStatus.recommendedActions.some((action) => action.action === "nudge")).toBe(true);
    expect(managerStatus.nextStep).toContain("stale");
  });

  it("records manager interventions as timeline events", async () => {
    const databasePath = createTestDatabaseLocation("team-status-manager-intervention");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const intervention = JSON.parse(await hooks.tool?.relay_team_intervene.execute({
      roomCode: started.roomCode,
      action: "retry",
      targetAlias: "planner",
      note: "send a valid TEAM_PROGRESS update",
      handoffTo: "planner",
      deliverables: "status-json"
    }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { action: string; accepted: boolean; targetAlias?: string; handoffTo?: string };

    expect(intervention.action).toBe("retry");
    expect(intervention.accepted).toBe(true);
    expect(intervention.targetAlias).toBe("planner");
    expect(intervention.handoffTo).toBe("planner");

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      recentEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
      interventionOutcomes: Array<{ action: string; targetAlias?: string; handoffTo?: string; status: string; reason: string }>; 
      policyDecisions: Array<{ mode: string; action?: string; targetAlias?: string; severity: string; reason: string; requiresExplicitApply: boolean; sourceKind: string }>;
      recommendedActions: Array<{ action: string; targetAlias?: string; handoffTo?: string; reason: string }>;
    };

    expect(managerStatus.recentEvents.some((event) => event.eventType === "team.manager.intervention" && event.payload.action === "retry" && event.payload.targetAlias === "planner")).toBe(true);
    expect(managerStatus.interventionOutcomes.some((outcome) => outcome.action === "retry" && outcome.targetAlias === "planner" && outcome.status === "pending")).toBe(true);
    expect(managerStatus.policyDecisions.some((decision) => decision.mode === "observe" && decision.targetAlias === "planner" && decision.sourceKind === "intervention_pending" && decision.requiresExplicitApply === false)).toBe(true);
    expect(managerStatus.recommendedActions.some((action) => action.action === "retry" && action.targetAlias === "planner")).toBe(false);
  });

  it("marks intervention outcomes acknowledged after a valid worker response", async () => {
    const databasePath = createTestDatabaseLocation("team-status-intervention-ack");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_READY] {\"source\":\"openspec\",\"phase\":\"join\",\"note\":\"planner ready\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-ready",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_team_intervene.execute({
      roomCode: started.roomCode,
      action: "retry",
      targetAlias: "planner",
      note: "send a valid TEAM_PROGRESS update"
    }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"source\":\"openspec\",\"phase\":\"tasks\",\"note\":\"planner resumed work\",\"progress\":50}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-progress-valid",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      interventionOutcomes: Array<{ action: string; targetAlias?: string; status: string; reason: string }>;
    };

    expect(managerStatus.interventionOutcomes.some((outcome) => outcome.action === "retry" && outcome.targetAlias === "planner" && outcome.status === "acknowledged")).toBe(true);
  });

  it("marks intervention outcomes resolved after a valid completion handoff", async () => {
    const databasePath = createTestDatabaseLocation("team-status-intervention-resolved");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_READY] {\"source\":\"openspec\",\"phase\":\"join\",\"note\":\"planner ready\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-ready",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_team_intervene.execute({
      roomCode: started.roomCode,
      action: "retry",
      targetAlias: "planner",
      note: "complete the handoff cleanly"
    }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"openspec\",\"phase\":\"tasks\",\"note\":\"planner completed the retry request\",\"evidence\":[\"tasks.md\"],\"handoffTo\":\"manager\",\"deliverables\":[\"tasks.md\"]}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-done-valid",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({}, {
      sessionID: "session-manager",
      messageID: "m3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      interventionOutcomes: Array<{ action: string; targetAlias?: string; status: string; reason: string }>;
    };

    expect(managerStatus.interventionOutcomes.some((outcome) => outcome.action === "retry" && outcome.targetAlias === "planner" && outcome.status === "resolved")).toBe(true);
  });

  it("applies an explicit policy decision through relay_team_apply_policy", async () => {
    const databasePath = createTestDatabaseLocation("team-status-apply-policy");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_READY] {\"source\":\"openspec\",\"phase\":\"join\",\"note\":\"planner ready\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-ready",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"note\":\"bad policy signal\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-progress-policy",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const applied = JSON.parse(await hooks.tool?.relay_team_apply_policy.execute({
      roomCode: started.roomCode,
      action: "retry",
      targetAlias: "planner"
    }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { applied: boolean; action: string; targetAlias?: string; mode: string; sourceKind: string };

    expect(applied.applied).toBe(true);
    expect(applied.action).toBe("retry");
    expect(applied.targetAlias).toBe("planner");
    expect(applied.mode).toBe("manual_intervention");
    expect(applied.sourceKind).toBe("rejected_signal");
  });

  it("marks the team run failed when worker bootstrap prompt submission fails", async () => {
    const databasePath = createTestDatabaseLocation("team-status-failure");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn()
      .mockResolvedValueOnce({ data: true })
      .mockRejectedValueOnce(new Error("prompt async failed"));

    const hooks = await RelayPlugin(createPluginInput("project-team-status-failure", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    await expect(hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    })).rejects.toThrow(/prompt async failed/);

    const state = getRelayPluginStateForTest("project-team-status-failure")!;
    const failedRun = state.runtime.teamStore.getRunForSession("session-manager");
    expect(failedRun?.status).toBe("failed");
  });

  it("rejects runId lookups from sessions outside the relay workflow team", async () => {
    const databasePath = createTestDatabaseLocation("team-status-authz");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-team-status", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m-authz-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { runId: string };

    await expect(hooks.tool?.relay_team_status.execute({ runId: started.runId }, {
      sessionID: "session-outsider",
      messageID: "m-authz-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    })).rejects.toThrow(/no relay workflow team is bound/i);
  });

  it("records invalid backward TEAM transitions as rejected signals without regressing worker state", async () => {
    const databasePath = createTestDatabaseLocation("team-status-transition-guard");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m-transition-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string; runId: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join-transition",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"openspec\",\"phase\":\"tasks\",\"note\":\"planner finished\",\"evidence\":[\"tasks.md\"],\"handoffTo\":\"manager\",\"deliverables\":[\"tasks.md\"]}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-done-transition",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"source\":\"openspec\",\"phase\":\"revision\",\"note\":\"planner tried to restart\",\"progress\":40}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-transition",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m-transition-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      workers: Array<{ alias: string; status: string }>;
      recentEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
    };

    expect(managerStatus.workers.find((worker) => worker.alias === "planner")?.status).toBe("completed");
    expect(managerStatus.recentEvents.some((event) => event.eventType === "team.worker.signal_rejected" && String(event.payload.rejectionReason).includes("completed -> in_progress"))).toBe(true);
  });

  it("clears retry recommendations once a worker sends a later valid signal", async () => {
    const databasePath = createTestDatabaseLocation("team-status-rejected-resolved");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-team-status"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m-resolved-1",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { roomCode: string; runId: string };

    await hooks.tool?.relay_room_join.execute({ roomCode: started.roomCode, alias: "planner" }, {
      sessionID: "session-planner",
      messageID: "session-planner-join-resolved",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_DONE] {\"source\":\"openspec\",\"phase\":\"tasks\",\"note\":\"planner finished\"}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-done-resolved",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_send.execute({ roomCode: started.roomCode, message: "[TEAM_PROGRESS] {\"source\":\"openspec\",\"phase\":\"revision\",\"note\":\"planner tried to restart\",\"progress\":40}" }, {
      sessionID: "session-planner",
      messageID: "session-planner-invalid-transition-resolved",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const state = getRelayPluginStateForTest("project-team-status")!;
    state.runtime.teamStore.markWorkerSignal("session-planner", started.roomCode, {
      status: "completed",
      note: "planner finished again",
      ready: true,
      source: "openspec",
      phase: "tasks-verified",
      progress: 100
    });
    state.runtime.auditStore.append(started.runId, "team.worker.completed", {
      sessionID: "session-planner",
      role: "planner",
      alias: "planner",
      roomCode: started.roomCode,
      note: "planner finished again",
      source: "openspec",
      phase: "tasks-verified",
      progress: 100,
      metadata: {}
    });

    const managerStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m-resolved-2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      recentEvents: Array<{ eventType: string; payload: Record<string, unknown> }>;
      attentionItems: Array<{ kind: string; targetAlias?: string }>;
      policyDecisions: Array<{ action?: string; targetAlias?: string; sourceKind: string }>;
      recommendedActions: Array<{ action: string; targetAlias?: string }>;
    };

    expect(managerStatus.recentEvents.some((event) => event.eventType === "team.worker.signal_rejected")).toBe(true);
    expect(managerStatus.attentionItems.some((item) => item.kind === "rejected_signal" && item.targetAlias === "planner")).toBe(false);
    expect(managerStatus.policyDecisions.some((decision) => decision.action === "retry" && decision.targetAlias === "planner" && decision.sourceKind === "rejected_signal")).toBe(false);
    expect(managerStatus.recommendedActions.some((action) => action.action === "retry" && action.targetAlias === "planner")).toBe(false);
  });
});
