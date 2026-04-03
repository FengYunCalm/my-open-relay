import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  ResponseObserver,
  SessionLinkStore,
  TaskEventHub,
  TaskStore,
  createSendMessageStreamHandler
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "../plugin/test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("streaming status", () => {
  it("emits task status updates in submitted -> working -> completed order", async () => {
    const location = createTestDatabaseLocation("e2e-stream-status");
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

    const { task, events } = await handler({
      jsonrpc: "2.0",
      id: "req-1",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-stream-1",
          role: "user",
          parts: [{ text: "hello", metadata: {} }],
          metadata: {}
        }
      }
    });

    const iterator = events[Symbol.asyncIterator]();
    const statuses: string[] = [];

    statuses.push((await iterator.next()).value?.status ?? "missing");
    observer.updateStatus(task.taskId, "working");
    statuses.push((await iterator.next()).value?.status ?? "missing");
    observer.updateStatus(task.taskId, "completed");
    statuses.push((await iterator.next()).value?.status ?? "missing");

    expect(statuses).toEqual(["submitted", "working", "completed"]);
  });
});
