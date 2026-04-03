import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  ResponseObserver,
  SessionLinkStore,
  TaskEventHub,
  TaskStore
} from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("response observer", () => {
  it("maps session observations into task state and outbound events", async () => {
    const location = createTestDatabaseLocation("response-observer");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const eventHub = new TaskEventHub();
    const observer = new ResponseObserver(taskStore, auditStore, sessionLinkStore, eventHub);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-1",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "submitted"
    });

    const stream = eventHub.stream(taskId)[Symbol.asyncIterator]();
    observer.accept(taskId, "session-1");
    observer.updateStatus(taskId, "working", {
      messageId: "msg-2",
      role: "agent",
      parts: [{ text: "working", metadata: {} }],
      metadata: {}
    });
    observer.appendArtifact(taskId, {
      artifactId: "artifact-1",
      name: "result",
      parts: [{ text: "done", metadata: {} }],
      metadata: {}
    });

    const first = await stream.next();
    const second = await stream.next();

    expect(first.value?.type).toBe("task-status-update");
    expect(first.value?.metadata).toEqual({});
    expect(second.value?.type).toBe("task-artifact-update");
    expect(taskStore.getTask(taskId)?.status).toBe("working");
    expect(sessionLinkStore.getSessionID(taskId)).toBe("session-1");
  });
});
