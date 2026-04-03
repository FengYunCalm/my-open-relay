import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginInput } from "@opencode-ai/plugin";

import {
  RelayPlugin,
  getRelayPluginStateForTest,
  stopRelayPlugin
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

async function waitForTaskId(projectID: string): Promise<string> {
  for (let index = 0; index < 50; index += 1) {
    const taskId = getRelayPluginStateForTest(projectID)?.runtime.taskStore.listActiveTasks()[0]?.taskId;
    if (taskId) {
      return taskId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  throw new Error(`Timed out waiting for active task in project ${projectID}`);
}

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
  await stopRelayPlugin("project-http");
  await stopRelayPlugin("project-http-stream");
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("A2A HTTP integration", () => {
  it("serves agent card and handles send/get/cancel JSON-RPC requests", async () => {
    const databasePath = createTestDatabaseLocation("plugin-http");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-http", promptAsync), {
      a2a: { port: 0 },
      runtime: { databasePath }
    });

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-1",
          status: { type: "idle" }
        }
      } as never
    });

    const state = getRelayPluginStateForTest("project-http");
    expect(state?.host.url).toBeTruthy();

    const agentCardResponse = await fetch(state!.host.url!);
    const agentCard = await agentCardResponse.json();
    expect(agentCard.protocolVersion).toBe("1.0");
    expect(agentCard.url).toBe(state!.host.url);

    const sendResponse = await fetch(state!.host.url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-send",
        method: "sendMessage",
        params: {
          sessionID: "session-1",
          message: {
            messageId: "msg-http-1",
            role: "user",
            parts: [{ text: "hello over http", metadata: {} }],
            metadata: {}
          }
        }
      })
    });
    const sendBody = await sendResponse.json();
    const taskId = sendBody.result.task.taskId as string;

    expect(sendResponse.status).toBe(200);
    expect(sendBody.result.task.status).toBe("working");
    expect(sendBody.result.task.metadata).toEqual({});
    expect(promptAsync).toHaveBeenCalledTimes(1);

    const getResponse = await fetch(state!.host.url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-get",
        method: "getTask",
        params: { taskId }
      })
    });
    const getBody = await getResponse.json();
    expect(getBody.result.task.taskId).toBe(taskId);
    expect(getBody.result.task.metadata).toEqual({});

    const cancelResponse = await fetch(state!.host.url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-cancel",
        method: "cancelTask",
        params: { taskId }
      })
    });
    const cancelBody = await cancelResponse.json();
    expect(cancelBody.result.task.status).toBe("canceled");
    expect(cancelBody.result.task.metadata).toEqual({});
  });

  it("streams SSE events for sendMessageStream", async () => {
    const databasePath = createTestDatabaseLocation("plugin-http-stream");
    dbLocations.push(databasePath);
    const promptAsync = vi.fn().mockResolvedValue({ data: true });
    const hooks = await RelayPlugin(createPluginInput("project-http-stream", promptAsync), {
      a2a: { port: 0 },
      runtime: { databasePath }
    });

    await hooks.event?.({
      event: {
        type: "session.status",
        properties: {
          sessionID: "session-stream-1",
          status: { type: "idle" }
        }
      } as never
    });

    const state = getRelayPluginStateForTest("project-http-stream");
    expect(state).toBeDefined();

    const responsePromise = fetch(state!.host.url!, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "req-stream",
        method: "sendMessageStream",
        params: {
          sessionID: "session-stream-1",
          message: {
            messageId: "msg-stream-http-1",
            role: "user",
            parts: [{ text: "hello stream", metadata: {} }],
            metadata: {}
          }
        }
      })
    });

    const response = await responsePromise;
    const taskId = await waitForTaskId("project-http-stream");

    state!.runtime.observer.appendArtifact(taskId, {
      artifactId: "artifact-stream-1",
      name: "result",
      parts: [{ text: "done", metadata: {} }],
      metadata: {}
    });
    state!.runtime.observer.updateStatus(taskId, "completed");

    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("\"result\":{\"task\"");
    expect(body).toContain("\"metadata\":{}");
    expect(body).toContain("\"method\":\"task.event\"");
    expect(body).toContain("completed");
  });
});
