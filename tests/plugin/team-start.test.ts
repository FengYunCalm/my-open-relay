import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(
  projectID = "project-team-start",
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
  await stopRelayPlugin("project-team-start");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("relay team start tool", () => {
  it("creates a manager-owned group room and bootstraps worker child sessions", async () => {
    const databasePath = createTestDatabaseLocation("team-start");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: undefined });
    const create = vi.fn()
      .mockResolvedValueOnce({ data: { id: "session-planner", title: "team/planner: ship team workflow" } })
      .mockResolvedValueOnce({ data: { id: "session-implementer", title: "team/implementer: ship team workflow" } })
      .mockResolvedValueOnce({ data: { id: "session-reviewer", title: "team/reviewer: ship team workflow" } });

    const hooks = await RelayPlugin(createPluginInput("project-team-start", promptAsync, create), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const started = await hooks.tool?.relay_team_start.execute({ task: "ship team workflow" }, {
      sessionID: "session-manager",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const parsed = JSON.parse(started ?? "{}");
    expect(parsed.roomKind).toBe("group");
    expect(parsed.managerSessionID).toBe("session-manager");
    expect(parsed.childSessions).toEqual([
      expect.objectContaining({ role: "planner", alias: "planner", sessionID: "session-planner" }),
      expect.objectContaining({ role: "implementer", alias: "implementer", sessionID: "session-implementer" }),
      expect.objectContaining({ role: "reviewer", alias: "reviewer", sessionID: "session-reviewer" })
    ]);

    expect(create).toHaveBeenCalledTimes(3);
    expect(create).toHaveBeenNthCalledWith(1, {
      body: { parentID: "session-manager", title: "team/planner: ship team workflow" },
      query: { directory: "C:/relay-project" }
    });
    expect(promptAsync).toHaveBeenCalledTimes(3);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
      path: { id: "session-planner" },
      body: {
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("Load the `relay-room` skill.")
          })
        ]
      }
    });
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: {
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("OpenSpec, Superpowers, and OMO")
          })
        ]
      }
    });
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: {
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("{\"source\":\"openspec|superpowers|omo\"")
          })
        ]
      }
    });

    const state = getRelayPluginStateForTest("project-team-start")!;
    const room = state.runtime.roomStore.getRoomBySession("session-manager")!;
    expect(room.kind).toBe("group");
    expect(hooks.tool?.["mcp__relay__team_start"]).toBeDefined();
  });
});
