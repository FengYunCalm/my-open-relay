import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  ResponseObserver,
  SessionLinkStore,
  TaskEventHub,
  TaskStore,
  createSendMessageStreamHandler
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("send message stream handler", () => {
  it("streams submitted, working, artifact, and completed updates in order", async () => {
    const location = createTestDatabaseLocation("send-message-stream");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const eventHub = new TaskEventHub();
    const observer = new ResponseObserver(taskStore, auditStore, sessionLinkStore, eventHub);

    const handler = createSendMessageStreamHandler(
      {
        taskStore,
        auditStore,
        sessionLinkStore,
        eventHub,
        executor: {
          dispatch: async () => ({ sessionID: "session-1" })
        }
      },
      eventHub
    );

    const result = await handler({
      jsonrpc: "2.0",
      id: "req-1",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-1",
          role: "user",
          parts: [{ text: "hello", metadata: {} }],
          metadata: {}
        }
      }
    });

    const stream = result.events[Symbol.asyncIterator]();
    const submitted = await stream.next();

    observer.updateStatus(result.task.taskId, "working", {
      messageId: "msg-2",
      role: "agent",
      parts: [{ text: "working", metadata: {} }],
      metadata: {}
    });
    const working = await stream.next();

    observer.appendArtifact(result.task.taskId, {
      artifactId: "artifact-1",
      name: "reply",
      parts: [{ text: "done", metadata: {} }],
      metadata: {}
    });
    const artifact = await stream.next();

    observer.updateStatus(result.task.taskId, "completed");
    const completed = await stream.next();
    const done = await stream.next();

    expect(submitted.value?.type).toBe("task-status-update");
    expect(working.value?.type).toBe("task-status-update");
    expect(working.value?.message?.metadata).toEqual({});
    expect(working.value?.message?.parts[0]?.metadata).toEqual({});
    expect(artifact.value?.type).toBe("task-artifact-update");
    expect(artifact.value?.artifact.metadata).toEqual({});
    expect(artifact.value?.artifact.parts[0]?.metadata).toEqual({});
    expect(completed.value?.type).toBe("task-status-update");
    expect(done.done).toBe(true);
  });
});
