import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-group-room-mcp", promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
  return {
    client: {
      session: {
        prompt: vi.fn().mockResolvedValue({ data: true }),
        promptAsync
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
  await stopRelayPlugin("project-group-room-mcp");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("MCP-first group room behavior", () => {
  it("uses namespaced tool IDs and preserves multiple members plus group broadcast delivery", async () => {
    const databasePath = createTestDatabaseLocation("group-room-mcp");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-group-room-mcp", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const createArgs = { args: { kind: "group" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_create", sessionID: "session-owner", callID: "call-1" }, createArgs);
    expect(createArgs.args.sessionID).toBe("session-owner");

    const stateModule = await import("../../packages/relay-plugin/src/internal/testing/state-access.ts");
    const state = stateModule.getRelayPluginStateForTest("project-group-room-mcp")!;
    const room = state.runtime.roomStore.createRoom(createArgs.args.sessionID as string, "group");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-b", "alpha");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-c", "beta");
    state.runtime.ensureDefaultThreadsForRoom(room.roomCode);

    const sendArgs = { args: { message: "broadcast update" } as Record<string, unknown> };
    await hooks["tool.execute.before"]?.({ tool: "mcp__relay__room_send", sessionID: "session-owner", callID: "call-2" }, sendArgs);
    expect(sendArgs.args.sessionID).toBe("session-owner");

    const result = await state.runtime.sendRoomMessage(sendArgs.args.sessionID as string, sendArgs.args.message as string);
    expect(result.peerSessionID).toBe("group");
    expect(promptAsync).toHaveBeenCalledTimes(2);
  });
});
