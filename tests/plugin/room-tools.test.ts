import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, RelayRuntime, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
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
  it("keeps the old private room flow unchanged", async () => {
    const databasePath = createTestDatabaseLocation("room-tools-private");
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

    expect(created).toContain("Room kind: private");
    const roomCode = created?.match(/Room code: (\d{6})/)?.[1];

    const joined = await hooks.tool?.relay_room_join.execute({ roomCode: roomCode! }, {
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
    const state = getRelayPluginStateForTest("project-room-tools")!;
    const room = state.runtime.roomStore.getRoomBySession("session-a")!;
    expect(room.kind).toBe("private");
    expect(state.runtime.roomStore.areSessionsPaired("session-a", "session-b")).toBe(true);
  });

  it("creates a group room, joins with alias, and can broadcast or direct-message a member", async () => {
    const databasePath = createTestDatabaseLocation("room-tools-group");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-room-tools", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const created = await hooks.tool?.relay_room_create.execute({ kind: "group" }, {
      sessionID: "session-a",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    expect(created).toContain("Room kind: group");
    const roomCode = created?.match(/Room code: (\d{6})/)?.[1]!;

    const joinedB = await hooks.tool?.relay_room_join.execute({ roomCode, alias: "alpha" }, {
      sessionID: "session-b",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const joinedC = await hooks.tool?.relay_room_join.execute({ roomCode, alias: "beta" }, {
      sessionID: "session-c",
      messageID: "message-c",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(joinedB).toContain("Alias: alpha");
    expect(joinedC).toContain("Alias: beta");

    const members = await hooks.tool?.relay_room_members.execute({}, {
      sessionID: "session-a",
      messageID: "message-d",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    expect(members).toContain("alpha");
    expect(members).toContain("beta");

    const broadcast = await hooks.tool?.relay_room_send.execute({ message: "all-hands update" }, {
      sessionID: "session-a",
      messageID: "message-e",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    expect(broadcast).toContain("Sent to peer session: group");
    expect(promptAsync).toHaveBeenCalledTimes(2);

    const direct = await hooks.tool?.relay_room_send.execute({ message: "private task", targetAlias: "alpha" }, {
      sessionID: "session-a",
      messageID: "message-f",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    expect(direct).toContain("Target alias: alpha");
  });

  it("sends a private-room message to the latest rejoined peer session", async () => {
    const databasePath = createTestDatabaseLocation("room-tools-private-rejoin");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-room-tools-rejoin", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const created = await hooks.tool?.relay_room_create.execute({}, {
      sessionID: "session-owner",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const roomCode = created?.match(/Room code: (\d{6})/)?.[1]!;

    await hooks.tool?.relay_room_join.execute({ roomCode }, {
      sessionID: "session-old",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    await hooks.tool?.relay_room_join.execute({ roomCode }, {
      sessionID: "session-new",
      messageID: "message-c",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const sent = await hooks.tool?.relay_room_send.execute({ message: "hello latest peer" }, {
      sessionID: "session-owner",
      messageID: "message-d",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(sent).toContain("Sent to peer session: session-new");
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ path: { id: "session-new" } });
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: {
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("Sender: paired agent session session-owner (not a human user)")
          })
        ]
      }
    });
  });

  it("shows the correct private-room peer even when the same owner is also in a group room", async () => {
    const databasePath = createTestDatabaseLocation("room-tools-private-status-multiroom");
    dbLocations.push(databasePath);
    const hooks = await RelayPlugin(createPluginInput("project-room-tools-status-multiroom"), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const privateCreated = await hooks.tool?.relay_room_create.execute({}, {
      sessionID: "session-owner",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const privateRoomCode = privateCreated?.match(/Room code: (\d{6})/)?.[1]!;
    await hooks.tool?.relay_room_join.execute({ roomCode: privateRoomCode }, {
      sessionID: "session-private-peer",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const groupCreated = await hooks.tool?.relay_room_create.execute({ kind: "group" }, {
      sessionID: "session-owner",
      messageID: "message-c",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const groupRoomCode = groupCreated?.match(/Room code: (\d{6})/)?.[1]!;
    await hooks.tool?.relay_room_join.execute({ roomCode: groupRoomCode, alias: "alpha" }, {
      sessionID: "session-group-a",
      messageID: "message-d",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const status = await hooks.tool?.relay_room_status.execute({ roomCode: privateRoomCode }, {
      sessionID: "session-owner",
      messageID: "message-e",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(status).toContain(`Room code: ${privateRoomCode}`);
    expect(status).toContain("Peer session: session-private-peer");
  });

  it("uses direct injection when sending through relay_message_send on a private direct thread", async () => {
    const databasePath = createTestDatabaseLocation("room-tools-private-thread-send");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-room-tools-private-thread-send", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const created = await hooks.tool?.relay_room_create.execute({}, {
      sessionID: "session-owner",
      messageID: "message-a",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });
    const roomCode = created?.match(/Room code: (\d{6})/)?.[1]!;

    await hooks.tool?.relay_room_join.execute({ roomCode }, {
      sessionID: "session-peer",
      messageID: "message-b",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    const threads = JSON.parse(await hooks.tool?.relay_thread_list.execute({ scope: "room" }, {
      sessionID: "session-owner",
      messageID: "message-c",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    }) as string) as Array<{ threadId: string; kind: string }>;
    const directThread = threads.find((thread) => thread.kind === "direct");

    const sent = await hooks.tool?.relay_message_send.execute({ threadId: directThread!.threadId, message: "hello through thread" }, {
      sessionID: "session-owner",
      messageID: "message-d",
      agent: "build",
      directory: "C:/relay-project",
      worktree: "C:/relay-project",
      abort: new AbortController().signal,
      metadata: () => {},
      ask: async () => {}
    });

    expect(sent).toContain('"notifiedRecipients": [');
    expect(promptAsync).toHaveBeenCalledTimes(1);
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({ path: { id: "session-peer" } });
    expect(promptAsync.mock.calls[0]?.[0]).toMatchObject({
      body: {
        parts: [
          expect.objectContaining({
            text: expect.stringContaining("Sender: paired agent session session-owner (not a human user)")
          })
        ]
      }
    });

    const state = getRelayPluginStateForTest("project-room-tools-private-thread-send")!;
    const diagnostics = state.runtime.auditStore.list(RelayRuntime.diagnosticsTaskId);
    expect(diagnostics.some((entry) => entry.eventType === "relay.send.entry" && entry.payload.tool === "relay_message_send")).toBe(true);
    expect(diagnostics.some((entry) => entry.eventType === "relay.send.route" && entry.payload.deliveryPath === "private-direct-hook")).toBe(true);
    expect(diagnostics.some((entry) => entry.eventType === "relay.send.inject" && entry.payload.injectorKind === "private-room-peer" && entry.payload.result === "ok")).toBe(true);
  });
});
