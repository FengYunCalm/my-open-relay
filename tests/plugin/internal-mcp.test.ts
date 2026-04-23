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
    auditStore.append("__relay_diagnostics__", "relay.send.entry", { surface: "plugin", tool: "relay_room_send" });

    const room = roomStore.createRoom("session-owner");
    roomStore.joinRoom(room.roomCode, "session-a");
    const thread = threadStore.ensureDirectThread(room.roomCode, ["session-owner", "session-a"], "session-owner");
    const pausedSessions = new Map<string, string>();

    const mcp = createRelayOpsMcpServer(taskStore, auditStore, roomStore, threadStore, messageStore, {
      getStatus: (requestedTaskId) => ({
        activeTaskCount: taskStore.listActiveTasks().length,
        roomCount: roomStore.countRooms(),
        threadCount: threadStore.countThreads(),
        knownSessionCount: 2,
        sessionStatusCounts: { idle: 1, busy: 1 },
        pausedSessionCount: pausedSessions.size,
        pausedSessions: [...pausedSessions.entries()].map(([sessionID, reason]) => ({ sessionID, reason })),
        recentDiagnostics: auditStore.list("__relay_diagnostics__").slice(-10),
        task: requestedTaskId ? taskStore.getTask(requestedTaskId) : undefined
      }),
      getDiagnostics: (limit) => auditStore.list("__relay_diagnostics__").slice(-(limit ?? 10)),
      pauseSession: (sessionID, reason) => {
        const resolvedReason = reason ?? "human takeover";
        pausedSessions.set(sessionID, resolvedReason);
        auditStore.append("__relay_diagnostics__", "relay.session.paused", { sessionID, reason: resolvedReason });
        return { sessionID, reason: resolvedReason, paused: true as const };
      },
      resumeSession: (sessionID) => {
        const previousReason = pausedSessions.get(sessionID);
        const resumed = pausedSessions.delete(sessionID);
        auditStore.append("__relay_diagnostics__", "relay.session.resumed", { sessionID, previousReason, resumed });
        return { sessionID, previousReason, resumed };
      },
      replayTask: async (requestedTaskId) => {
        const replayed = taskStore.updateStatus(requestedTaskId, "submitted");
        auditStore.append(requestedTaskId, "task.replayed", {});
        return replayed;
      },
      listRoomMembers: (roomCode) => roomStore.listMembers(roomCode),
      createThread: ({ roomCode, kind, createdBySessionID, participantSessionIDs, title }) => kind === "group"
        ? threadStore.createGroupThread(roomCode, participantSessionIDs, createdBySessionID, title)
        : threadStore.ensureDirectThread(roomCode, participantSessionIDs, createdBySessionID),
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
      "relay-diagnostics",
      "relay-pause",
      "relay-resume",
      "relay-replay",
      "relay-room-members",
      "relay-thread-create",
      "relay-thread-list",
      "relay-message-list",
      "relay-message-send",
      "relay-message-mark-read",
      "relay-transcript-export"
    ]);
    expect(statusTool.execute(taskId)).toMatchObject({
      activeTaskCount: 0,
      roomCount: 1,
      threadCount: 1,
      knownSessionCount: 2,
      pausedSessionCount: 0,
      task: { taskId }
    });
    expect(mcp.getDiagnostics()).toHaveLength(1);

    const paused = mcp.pauseSession("session-a", "operator pause") as { paused: boolean; reason: string };
    expect(paused).toEqual({ paused: true, reason: "operator pause", sessionID: "session-a" });
    expect(statusTool.execute().pausedSessionCount).toBe(1);

    const resumed = mcp.resumeSession("session-a") as { resumed: boolean; previousReason?: string };
    expect(resumed).toMatchObject({ resumed: true, previousReason: "operator pause", sessionID: "session-a" });
    expect(statusTool.execute().pausedSessionCount).toBe(0);
    expect(mcp.getDiagnostics().map((event) => event.eventType)).toEqual([
      "relay.send.entry",
      "relay.session.paused",
      "relay.session.resumed"
    ]);

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
      getDiagnostics: () => [],
      pauseSession: (sessionID, reason) => ({ sessionID, reason, paused: true }),
      resumeSession: (sessionID) => ({ sessionID, resumed: false }),
      replayTask: async (requestedTaskId) => {
        const task = taskStore.getTask(requestedTaskId)!;
        if (task.status !== "failed" && task.status !== "canceled") {
          throw new Error(`Task ${requestedTaskId} is not replayable from status ${task.status}.`);
        }
        return task;
      },
      listRoomMembers: () => [],
      createThread: () => undefined,
      listThreads: () => [],
      listMessages: () => [],
      sendThreadMessage: async () => undefined,
      markThreadRead: () => undefined,
      exportTranscript: () => undefined
    });

    await expect(mcp.replayTask(taskId)).rejects.toThrow(/not replayable/);
  });
});
