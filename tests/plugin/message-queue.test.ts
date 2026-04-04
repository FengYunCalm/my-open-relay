import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-message-queue", promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
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
  await stopRelayPlugin("project-message-queue");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("durable room message queue", () => {
  it("drains more than one pending thread across consecutive notifications in a single idle transition", async () => {
    const databasePath = createTestDatabaseLocation("message-queue-multi-thread");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-message-queue", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const state = getRelayPluginStateForTest("project-message-queue")!;
    const room = state.runtime.roomStore.createRoom("session-owner", "group");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-a", "alpha");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-b", "beta");

    const directThread = state.runtime.threadStore.ensureDirectThread(room.roomCode, ["session-owner", "session-a"], "session-owner");
    const groupThread = state.runtime.createThread({
      roomCode: room.roomCode,
      kind: "group",
      createdBySessionID: "session-owner",
      participantSessionIDs: ["session-owner", "session-a", "session-b"],
      title: "team"
    });

    state.runtime.messageStore.appendMessage({ threadId: directThread.threadId, senderSessionID: "session-owner", messageType: "relay", body: { text: "direct hello" } });
    state.runtime.messageStore.appendMessage({ threadId: groupThread.threadId, senderSessionID: "session-owner", messageType: "relay", body: { text: "group hello" } });

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-a",
          status: { type: "idle" }
        }
      } as never
    });

    expect(promptAsync).toHaveBeenCalledTimes(2);
    const directParticipant = state.runtime.threadStore.getParticipant(directThread.threadId, "session-a");
    const groupParticipant = state.runtime.threadStore.getParticipant(groupThread.threadId, "session-a");
    expect(directParticipant?.lastNotifiedSeq).toBe(1);
    expect(groupParticipant?.lastNotifiedSeq).toBe(1);
  });
});
