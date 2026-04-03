import { afterEach, describe, expect, it } from "vitest";

import { AuditStore, SessionLinkStore, TaskStore } from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("relay stores", () => {
  it("persists tasks, audit entries, and session links across reopen", () => {
    const location = createTestDatabaseLocation("relay-store");
    dbLocations.push(location);

    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      contextId: "context-1",
      requestMessage: {
        messageId: "msg-1",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "submitted",
      metadata: { origin: "test" }
    });
    auditStore.append(taskId, "task.created", { ok: true });
    sessionLinkStore.link(taskId, "session-1");
    taskStore.close();
    auditStore.close();
    sessionLinkStore.close();

    const reopenedTaskStore = new TaskStore(location);
    const reopenedAuditStore = new AuditStore(location);
    const reopenedLinkStore = new SessionLinkStore(location);

    expect(reopenedTaskStore.listActiveTasks()).toHaveLength(1);
    expect(reopenedTaskStore.getTask(taskId)?.contextId).toBe("context-1");
    expect(reopenedAuditStore.list(taskId)).toHaveLength(1);
    expect(reopenedLinkStore.getSessionID(taskId)).toBe("session-1");
  });
});
