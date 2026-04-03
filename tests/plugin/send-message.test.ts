import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  SessionLinkStore,
  TaskStore,
  createSendMessageHandler,
  HumanGuard,
  LoopGuard
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

function createRequest(messageId = "msg-1") {
  return {
    jsonrpc: "2.0" as const,
    id: "req-1",
    method: "sendMessage",
    params: {
      sessionID: "session-1",
      contextId: "context-1",
      message: {
        messageId,
        role: "user" as const,
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      metadata: {
        source: "test"
      }
    }
  };
}

describe("send message handler", () => {
  it("creates a tracked task and links the session", async () => {
    const location = createTestDatabaseLocation("send-message");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);

    const handler = createSendMessageHandler({
      taskStore,
      auditStore,
      sessionLinkStore,
      executor: {
        dispatch: async () => ({ sessionID: "session-1" })
      }
    });

    const task = await handler(createRequest());

    expect(task.status).toBe("submitted");
    expect(task.metadata.sessionID).toBe("session-1");
    expect(sessionLinkStore.getSessionID(task.taskId)).toBe("session-1");
    expect(auditStore.list(task.taskId)).toHaveLength(1);
  });

  it("returns the existing task for duplicate requests", async () => {
    const location = createTestDatabaseLocation("send-message-dup");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const loopGuard = new LoopGuard();

    const handler = createSendMessageHandler({
      taskStore,
      auditStore,
      sessionLinkStore,
      loopGuard,
      executor: {
        dispatch: async () => ({ sessionID: "session-1" })
      }
    });

    const first = await handler(createRequest("msg-duplicate"));
    const second = await handler(createRequest("msg-duplicate"));

    expect(second.taskId).toBe(first.taskId);
  });

  it("stops automated dispatch when human takeover is active", async () => {
    const location = createTestDatabaseLocation("send-message-human");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const humanGuard = new HumanGuard();
    humanGuard.pauseSession("session-1", "operator is replying manually");

    let dispatchCalled = false;
    const handler = createSendMessageHandler({
      taskStore,
      auditStore,
      sessionLinkStore,
      humanGuard,
      executor: {
        dispatch: async () => {
          dispatchCalled = true;
          return { sessionID: "session-1" };
        }
      }
    });

    const task = await handler(createRequest("msg-human"));

    expect(task.status).toBe("input-required");
    expect(dispatchCalled).toBe(false);
  });
});
