import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  TaskStore,
  createRelayOpsMcpServer
} from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "../plugin/test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("replay flow", () => {
  it("replays a failed task back to submitted and records an audit entry", async () => {
    const location = createTestDatabaseLocation("e2e-replay");
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
    const replayed = await mcp.replayTask(taskId) as { status: string };

    expect(replayed.status).toBe("submitted");
    expect(auditStore.list(taskId).map((event) => event.eventType)).toContain("task.replayed");
  });
});
