import { afterEach, describe, expect, it } from "vitest";

import {
  AuditStore,
  MessageStore,
  RoomStore,
  TaskStore,
  ThreadStore,
  createRelayOpsMcpServer,
  createRelayReplayTool,
  createRelayStatusTool,
  createTaskResource
} from "../support/relay-plugin-testkit.js";
import { createOpaqueId } from "@opencode-peer-session-relay/a2a-protocol";

import { cleanupDatabaseLocation, createTestDatabaseLocation } from "./test-db.js";

const dbLocations: string[] = [];

afterEach(() => {
  dbLocations.splice(0).forEach(cleanupDatabaseLocation);
});

describe("internal MCP ops surface", () => {
  it("exposes status, replay, thread, message, and transcript helpers", async () => {
    const location = createTestDatabaseLocation("internal-mcp");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const roomStore = new RoomStore(location);
    const threadStore = new ThreadStore(location);
    const messageStore = new MessageStore(location);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-1",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "failed"
    });
    auditStore.append(taskId, "task.failed", { reason: "boom" });

    const room = roomStore.createRoom("session-owner");
    roomStore.joinRoom(room.roomCode, "session-a");
    const thread = threadStore.ensureDirectThread(room.roomCode, ["session-owner", "session-a"], "session-owner");

    const mcp = createRelayOpsMcpServer(taskStore, auditStore, roomStore, threadStore, messageStore, {
      replayTask: async (requestedTaskId) => {
        const replayed = taskStore.updateStatus(requestedTaskId, "submitted");
        auditStore.append(requestedTaskId, "task.replayed", {});
        return replayed;
      },
      listThreads: ({ roomCode, sessionID }) => roomCode ? threadStore.listThreadsForRoom(roomCode) : sessionID ? threadStore.listThreadsForSession(sessionID) : [],
      listMessages: (threadId, afterSeq, limit) => messageStore.listMessages(threadId, afterSeq, limit),
      sendThreadMessage: async ({ threadId, senderSessionID, message, messageType }) => {
        const appended = messageStore.appendMessage({ threadId, senderSessionID, messageType: messageType ?? "relay", body: { text: message } });
        threadStore.markRead(threadId, senderSessionID, appended.seq);
        return appended;
      },
      markThreadRead: ({ threadId, sessionID, seq }) => threadStore.markRead(threadId, sessionID, seq),
      exportTranscript: (threadId) => messageStore.exportTranscript(threadStore.getThread(threadId)!, threadStore.listParticipants(threadId))
    });
    const statusTool = createRelayStatusTool(mcp);
    const replayTool = createRelayReplayTool(mcp);
    const taskResource = createTaskResource(mcp);

    expect(mcp.toolNames).toEqual([
      "relay-status",
      "relay-replay",
      "relay-room-members",
      "relay-thread-create",
      "relay-thread-list",
      "relay-message-list",
      "relay-message-send",
      "relay-message-mark-read",
      "relay-transcript-export"
    ]);
    expect(statusTool.execute(taskId)).toMatchObject({ activeTaskCount: 0, task: { taskId } });

    const replayed = await replayTool.execute(taskId) as { status: string };
    expect(replayed.status).toBe("submitted");

    const sent = await mcp.sendThreadMessage({ threadId: thread.threadId, senderSessionID: "session-owner", message: "hello room" }) as { seq: number };
    expect(sent.seq).toBe(1);
    expect(mcp.listMessages(thread.threadId)).toHaveLength(1);
    expect(mcp.listThreads({ roomCode: room.roomCode })).toHaveLength(1);

    const participant = mcp.markThreadRead({ threadId: thread.threadId, sessionID: "session-a", seq: 1 }) as { lastReadSeq: number };
    expect(participant.lastReadSeq).toBe(1);

    const transcript = mcp.exportTranscript(thread.threadId) as { messages: Array<{ body: { text: string } }> };
    expect(transcript.messages[0]?.body.text).toBe("hello room");

    const resource = taskResource.read(taskId);
    expect(resource.uri).toBe(`relay://task/${taskId}`);
    expect(resource.text).toContain(taskId);
    expect(resource.text).toContain("task.failed");
  });

  it("rejects replay for non-recoverable task states", async () => {
    const location = createTestDatabaseLocation("internal-mcp-nonreplay");
    dbLocations.push(location);
    const taskStore = new TaskStore(location);
    const auditStore = new AuditStore(location);
    const roomStore = new RoomStore(location);
    const threadStore = new ThreadStore(location);
    const messageStore = new MessageStore(location);
    const taskId = createOpaqueId("task");

    taskStore.createTask({
      taskId,
      requestMessage: {
        messageId: "msg-2",
        role: "user",
        parts: [{ text: "hello", metadata: {} }],
        metadata: {}
      },
      status: "submitted"
    });

    const mcp = createRelayOpsMcpServer(taskStore, auditStore, roomStore, threadStore, messageStore, {
      replayTask: async (requestedTaskId) => {
        const task = taskStore.getTask(requestedTaskId)!;
        if (task.status !== "failed" && task.status !== "canceled") {
          throw new Error(`Task ${requestedTaskId} is not replayable from status ${task.status}.`);
        }
        return task;
      },
      listThreads: () => [],
      listMessages: () => [],
      sendThreadMessage: async () => undefined,
      markThreadRead: () => undefined,
      exportTranscript: () => undefined
    });

    await expect(mcp.replayTask(taskId)).rejects.toThrow(/not replayable/);
  });
});
