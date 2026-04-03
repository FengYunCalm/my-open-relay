import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  ResponseObserver,
  SessionLinkStore,
  TaskEventHub,
  TaskStore,
  createSendMessageHandler
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "../plugin/test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("a2a happy path", () => {
  it("bridges one request into submitted, working, artifact, and completed states", async () => {
    const location = createTestDatabaseLocation("e2e-happy");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const eventHub = new TaskEventHub();
    const observer = new ResponseObserver(taskStore, auditStore, sessionLinkStore, eventHub);

    const handler = createSendMessageHandler({
      taskStore,
      auditStore,
      sessionLinkStore,
      executor: {
        dispatch: async () => ({ sessionID: "session-1" })
      }
    });

    const task = await handler({
      jsonrpc: "2.0",
      id: "req-1",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-e2e-1",
          role: "user",
          parts: [{ text: "hello", metadata: {} }],
          metadata: {}
        }
      }
    });

    observer.updateStatus(task.taskId, "working");
    observer.appendArtifact(task.taskId, {
      artifactId: "artifact-1",
      name: "answer",
      parts: [{ text: "hi", metadata: {} }],
      metadata: {}
    });
    observer.updateStatus(task.taskId, "completed");

    const finalTask = taskStore.getTask(task.taskId);
    expect(finalTask?.status).toBe("completed");
    expect(finalTask?.artifacts).toHaveLength(1);
    expect(sessionLinkStore.getSessionID(task.taskId)).toBe("session-1");
  });
});
