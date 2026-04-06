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
    expect(managerStatus.nextStep).toContain("in progress");

    const compactionOutput = { context: [] as string[] };
    await hooks["experimental.session.compacting"]?.({ sessionID: "session-manager" }, compactionOutput);
    expect(compactionOutput.context.join("\n")).toContain("## Team Workflow");
    expect(compactionOutput.context.join("\n")).toContain(started.roomCode);

    const state = getRelayPluginStateForTest("project-team-status")!;
    expect(state.runtime.teamStore.getRun(started.runId)?.status).toBe("in_progress");
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
      nextStep: string;
    };

    expect(managerStatus.summary.healthCounts.stale).toBe(3);
    expect(managerStatus.workers.every((worker) => worker.health === "stale")).toBe(true);
    expect(managerStatus.nextStep).toContain("stale");
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
});
