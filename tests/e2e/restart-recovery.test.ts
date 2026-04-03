import { afterEach, describe, expect, it } from "vitest";

import { TaskStore } from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "../plugin/test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("restart recovery", () => {
  it("reloads unresolved tasks from persisted storage", () => {
    const location = createTestDatabaseLocation("e2e-restart");
    dbLocations.push(location);
    const taskId = createOpaqueId("task");

    const firstStore = new TaskStore(location);
    firstStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-1",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "working"
    });
    firstStore.close();

    const secondStore = new TaskStore(location);
    const activeTasks = secondStore.listActiveTasks();

    expect(activeTasks).toHaveLength(1);
    expect(activeTasks[0]?.taskId).toBe(taskId);
    expect(activeTasks[0]?.status).toBe("working");
  });
});
