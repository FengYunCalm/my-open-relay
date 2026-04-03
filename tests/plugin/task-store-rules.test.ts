import { afterEach, describe, expect, it } from "vitest";

import { TaskStore } from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("task cancellation rules", () => {
  it("rejects cancel attempts for completed tasks", () => {
    const location = createTestDatabaseLocation("task-cancel-guard");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-1",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "completed"
    });

    expect(() => taskStore.cancelTask(taskId)).toThrow(/not cancellable/);
  });
});
