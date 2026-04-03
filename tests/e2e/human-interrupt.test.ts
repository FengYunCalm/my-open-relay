import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  HumanGuard,
  SessionLinkStore,
  TaskStore,
  createSendMessageHandler
} from "../support/relay-plugin-testkit.js";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "../plugin/test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("human interrupt", () => {
  it("keeps automation paused until the operator resumes the session", async () => {
    const location = createTestDatabaseLocation("e2e-human");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const sessionLinkStore = new SessionLinkStore(location);
    const humanGuard = new HumanGuard();
    humanGuard.pauseSession("session-1", "operator typing");

    let dispatchCalls = 0;
    const handler = createSendMessageHandler({
      taskStore,
      auditStore,
      sessionLinkStore,
      humanGuard,
      executor: {
        dispatch: async () => {
          dispatchCalls += 1;
          return { sessionID: "session-1" };
        }
      }
    });

    const pausedTask = await handler({
      jsonrpc: "2.0",
      id: "req-1",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-human-1",
          role: "user",
          parts: [{ text: "hello", metadata: {} }],
          metadata: {}
        }
      }
    });

    humanGuard.resumeSession("session-1");
    const resumedTask = await handler({
      jsonrpc: "2.0",
      id: "req-2",
      method: "sendMessage",
      params: {
        sessionID: "session-1",
        message: {
          messageId: "msg-human-2",
          role: "user",
          parts: [{ text: "hello again", metadata: {} }],
          metadata: {}
        }
      }
    });

    expect(pausedTask.status).toBe("input-required");
    expect(resumedTask.status).toBe("submitted");
    expect(dispatchCalls).toBe(1);
  });
});
