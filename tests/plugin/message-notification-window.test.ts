import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import { RelayPlugin, getRelayPluginStateForTest, stopRelayPlugin } from "../support/relay-plugin-testkit.js";
import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID = "project-notify-window", promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
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
  await stopRelayPlugin("project-notify-window");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("message notification window", () => {
  it("only advances lastNotifiedSeq to the last actually delivered unread message chunk", async () => {
    const databasePath = createTestDatabaseLocation("notify-window");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-notify-window", promptAsync), {
      a2a: { port: 0 },
      routing: { mode: "pair" },
      runtime: { databasePath }
    });

    const state = getRelayPluginStateForTest("project-notify-window")!;
    const room = state.runtime.roomStore.createRoom("session-owner");
    state.runtime.roomStore.joinRoom(room.roomCode, "session-a");
    const thread = state.runtime.threadStore.ensureDirectThread(room.roomCode, ["session-owner", "session-a"], "session-owner");

    for (let index = 0; index < 55; index += 1) {
      state.runtime.messageStore.appendMessage({
        threadId: thread.threadId,
        senderSessionID: "session-owner",
        messageType: "relay",
        body: { text: `msg-${index + 1}` }
      });
    }

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-a",
          status: { type: "idle" }
        }
      } as never
    });

    const participant = state.runtime.threadStore.getParticipant(thread.threadId, "session-a");
    expect(promptAsync).toHaveBeenCalledTimes(2);
    expect(participant?.lastNotifiedSeq).toBe(55);
  }, 15000);
});
