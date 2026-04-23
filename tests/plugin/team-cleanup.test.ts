import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(
  projectID = "project-team-cleanup",
  promptAsync = vi.fn().mockResolvedValue({ data: undefined }),
  create = vi.fn()
    .mockResolvedValueOnce({ data: { id: "session-planner", title: "team/planner: ship team workflow" } })
    .mockResolvedValueOnce({ data: { id: "session-implementer", title: "team/implementer: ship team workflow" } })
    .mockResolvedValueOnce({ data: { id: "session-reviewer", title: "team/reviewer: ship team workflow" } }),
  get = vi.fn((options: { path: { id: string } }) => Promise.resolve({ data: { id: options.path.id } })),
  remove = vi.fn().mockResolvedValue({ data: true })
): PluginInput {
  return {
    client: {
      session: {
        prompt: vi.fn().mockResolvedValue({ data: true }),
        promptAsync,
        create,
        get,
        delete: remove
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
  await stopRelayPlugin("project-team-cleanup");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("relay team cleanup tool", () => {
  it("deletes worker root sessions after a settled run and marks them cleaned up", async () => {
    const databasePath = createTestDatabaseLocation("team-cleanup");
    dbLocations.push(databasePath);
    const remove = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-team-cleanup", vi.fn().mockResolvedValue({ data: undefined }), undefined, undefined, remove), {
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
    }) as string) as { runId: string };

    const state = getRelayPluginStateForTest("project-team-cleanup")!;
    state.runtime.teamStore.markRunFailed(started.runId);

    const cleaned = JSON.parse(await hooks.tool?.relay_team_cleanup.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m2",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as {
      cleaned: Array<{ alias: string; sessionID: string; reason: string }>;
      failed: Array<unknown>;
      alreadyCleaned: Array<unknown>;
    };

    expect(cleaned.failed).toEqual([]);
    expect(cleaned.alreadyCleaned).toEqual([]);
    expect(cleaned.cleaned).toHaveLength(3);
    expect(cleaned.cleaned.map((worker) => worker.alias)).toEqual(["planner", "implementer", "reviewer"]);
    expect(remove).toHaveBeenCalledTimes(3);
    expect(remove).toHaveBeenNthCalledWith(1, {
      path: { id: "session-planner" },
      query: { directory: "C:/relay-project" }
    });

    const cleanedWorkers = state.runtime.teamStore.listWorkers(started.runId);
    expect(cleanedWorkers.every((worker) => typeof worker.cleanedUpAt === "number")).toBe(true);

    const teamStatus = JSON.parse(await hooks.tool?.relay_team_status.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m3",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { workers: Array<{ health: string }>; nextStep: string };

    expect(teamStatus.workers.every((worker) => worker.health === "cleaned_up")).toBe(true);
    expect(teamStatus.nextStep).toContain("cleaned up");

    const secondPass = JSON.parse(await hooks.tool?.relay_team_cleanup.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m4",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { cleaned: Array<unknown>; alreadyCleaned: Array<unknown> };

    expect(secondPass.cleaned).toEqual([]);
    expect(secondPass.alreadyCleaned).toHaveLength(3);
    expect(remove).toHaveBeenCalledTimes(3);
  });

  it("requires a settled run unless force is set", async () => {
    const databasePath = createTestDatabaseLocation("team-cleanup-force");
    dbLocations.push(databasePath);
    const remove = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-team-cleanup", vi.fn().mockResolvedValue({ data: undefined }), undefined, undefined, remove), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = JSON.parse(await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "m5",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { runId: string };

    await expect(hooks.tool?.relay_team_cleanup.execute({ runId: started.runId }, {
      sessionID: "session-manager",
      messageID: "m6",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    })).rejects.toThrow(/completed or failed/);

    const forced = JSON.parse(await hooks.tool?.relay_team_cleanup.execute({ runId: started.runId, force: true }, {
      sessionID: "session-manager",
      messageID: "m7",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as { force: boolean; cleaned: Array<unknown> };

    expect(forced.force).toBe(true);
    expect(forced.cleaned).toHaveLength(3);
  });
});
