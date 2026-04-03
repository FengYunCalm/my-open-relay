import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  LoopGuard,
  SessionLinkStore,
  TaskStore,
  createSendMessageHandler
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "../plugin/test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("duplicate suppression", () => {
  it("suppresses repeated business execution for the same dedupe key", async () => {
    const location = createTestDatabaseLocation("e2e-duplicate");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const loopGuard = new LoopGuard();

    let dispatchCalls = 0;
    const handler = createSendMessageHandler({
      taskStore,
      auditStore,
      sessionLinkStore,
      loopGuard,
      executor: {
        dispatch: async () => {
          dispatchCalls += 1;
          return { sessionID: "session-1" };
        }
      }
    });

    const first = await handler({
      jsonrpc: "2.0",
      id: "req-1",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-dup-1",
          role: "user",
          parts: [{ text: "hello", metadata: {} }],
          metadata: {}
        }
      }
    });
    const second = await handler({
      jsonrpc: "2.0",
      id: "req-2",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-dup-1",
          role: "user",
          parts: [{ text: "hello", metadata: {} }],
          metadata: {}
        }
      }
    });

    expect(second.taskId).toBe(first.taskId);
    expect(dispatchCalls).toBe(1);
  });
});
