import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import {
  RelayPlugin,
  getRelayPluginStateForTest,
  stopRelayPlugin
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

function createPluginInput(projectID: string, promptAsync = vi.fn().mockResolvedValue({ data: true })): PluginInput {
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
      time: {
        created: Date.now()
      }
    } as PluginInput["project"],
    directory: "C:/relay-project",
    worktree: "C:/relay-project",
    serverUrl: new URL("http://127.0.0.1:4096"),
    $: {} as PluginInput["$"]
  };
}

afterEach(async () => {
  await stopRelayPlugin("project-replay-runtime");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("relay runtime replay", () => {
  it("replays a failed task through the runtime and redispatches on idle session", async () => {
    const databasePath = createTestDatabaseLocation("replay-runtime");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-replay-runtime", promptAsync), {
      a2a: { port: 0 },
      runtime: { databasePath }
    });

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-replay-1",
          status: { type: "idle" }
        }
      } as never
    });

    const state = getRelayPluginStateForTest("project-replay-runtime")!;
    const createdTask = state.runtime.taskStore.createTask({
      taskId: "task-replay-1",
      requestMessage: {
        messageId: "msg-replay-1",
        role: "user",
        parts: [{ text: "redo this", metadata: { internal: true } }],
        metadata: { internal: true }
      },
      status: "failed",
      metadata: { sessionID: "session-replay-1" }
    });
    state.runtime.sessionLinkStore.link(createdTask.taskId, "session-replay-1");

    const replayed = await state.runtime.replayTask(createdTask.taskId);

    expect(replayed?.status).toBe("working");
    expect(promptAsync).toHaveBeenCalledTimes(1);
  });
});
