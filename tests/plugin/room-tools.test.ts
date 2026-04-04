import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-room-tools", promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
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
  await stopRelayPlugin("project-room-tools");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("relay room tools", () => {
  it("creates and joins a room from two sessions", async () => {
    const databasePath = createTestDatabaseLocation("room-tools");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput(), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const created = await hooks.tool?.relay_room_create.execute({}, {
      sessionID: "session-a",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const roomCodeMatch = created?.match(/Room code: (\d{6})/);
    expect(roomCodeMatch?.[1]).toBeDefined();

    const joined = await hooks.tool?.relay_room_join.execute({ roomCode: roomCodeMatch![1] }, {
      sessionID: "session-b",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(joined).toContain("Joined room");
    const state = getRelayPluginStateForTest("project-room-tools");
    expect(state?.runtime.roomStore.areSessionsPaired("session-a", "session-b")).toBe(true);
  });

  it("sends a room message to the paired peer session", async () => {
    const databasePath = createTestDatabaseLocation("room-send-tools");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-room-tools", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-b",
          status: { type: "idle" }
        }
      } as never
    });

    const created = await hooks.tool?.relay_room_create.execute({}, {
      sessionID: "session-a",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const roomCode = created?.match(/Room code: (\d{6})/)?.[1];

    await hooks.tool?.relay_room_join.execute({ roomCode: roomCode! }, {
      sessionID: "session-b",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const sent = await hooks.tool?.relay_room_send.execute({ message: "hello peer" }, {
      sessionID: "session-a",
      messageID: "message-c",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(sent).toContain("Sent to peer session: session-b");
    expect(sent).toContain("Accepted: yes");
    expect(promptAsync).toHaveBeenCalledWith({
      path: { id: "session-b" },
      body: {
        system: undefined,
        parts: [
          {
            type: "text",
            text: expect.stringContaining("hello peer")
          }
        ]
      }
    });
  });

  it("does not send a room message when the peer session is known busy", async () => {
    const databasePath = createTestDatabaseLocation("room-send-busy");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-room-tools", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-b",
          status: { type: "busy" }
        }
      } as never
    });

    const created = await hooks.tool?.relay_room_create.execute({}, {
      sessionID: "session-a",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const roomCode = created?.match(/Room code: (\d{6})/)?.[1];

    await hooks.tool?.relay_room_join.execute({ roomCode: roomCode! }, {
      sessionID: "session-b",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const sent = await hooks.tool?.relay_room_send.execute({ message: "hello peer" }, {
      sessionID: "session-a",
      messageID: "message-c",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(sent).toContain("Accepted: no");
    expect(sent).toContain("session is busy");
    expect(promptAsync).not.toHaveBeenCalled();
  });
});
