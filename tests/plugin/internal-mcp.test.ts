import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  TaskStore,
  createRelayOpsMcpServer,
  createRelayReplayTool,
  createRelayStatusTool,
  createTaskResource
} from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("internal MCP ops surface", () => {
  it("exposes status, replay, and task resource helpers", async () => {
    const location = createTestDatabaseLocation("internal-mcp");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-1",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "failed"
    });
    auditStore.append(taskId, "task.failed", { reason: "boom" });

    const mcp = createRelayOpsMcpServer(taskStore, auditStore, {
      replayTask: async (requestedTaskId) => {
        const replayed = taskStore.updateStatus(requestedTaskId, "submitted");
        auditStore.append(requestedTaskId, "task.replayed", {});
        return replayed;
      }
    });
    const statusTool = createRelayStatusTool(mcp);
    const replayTool = createRelayReplayTool(mcp);
    const taskResource = createTaskResource(mcp);

    expect(mcp.toolNames).toEqual(["relay-status", "relay-replay"]);
    expect(statusTool.execute(taskId)).toMatchObject({ activeTaskCount: 0, task: { taskId } });

    const replayed = await replayTool.execute(taskId) as { status: string };
    expect(replayed.status).toBe("submitted");

    const resource = taskResource.read(taskId);
    expect(resource.uri).toBe(`relay://task/${taskId}`);
    expect(resource.text).toContain(taskId);
    expect(resource.text).toContain("task.failed");
  });

  it("rejects replay for non-recoverable task states", async () => {
    const location = createTestDatabaseLocation("internal-mcp-nonreplay");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-2",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "submitted"
    });

    const mcp = createRelayOpsMcpServer(taskStore, auditStore, {
      replayTask: async (requestedTaskId) => {
        const task = taskStore.getTask(requestedTaskId)!;
        if (task.status !== "failed" && task.status !== "canceled") {
          throw new Error(`Task ${requestedTaskId} is not replayable from status ${task.status}.`);
        }
        return task;
      }
    });

    await expect(mcp.replayTask(taskId)).rejects.toThrow(/not replayable/);
  });
});
