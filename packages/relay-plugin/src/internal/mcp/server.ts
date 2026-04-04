import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { AuditStore } from "../store/audit-store.js";
import type { MessageStore } from "../store/message-store.js";
import type { RoomStore } from "../store/room-store.js";
import type { TaskStore } from "../store/task-store.js";
import type { ThreadStore } from "../store/thread-store.js";

export type RelayOpsHandlers = {
  getStatus?: (taskId?: string) => {
    activeTaskCount: number;
    task?: unknown;
  };
  replayTask: (taskId: string) => Promise<unknown> | unknown;
  listRoomMembers: (roomCode: string) => unknown;
  createThread: (input: { roomCode: string; kind: "direct" | "group"; createdBySessionID: string; participantSessionIDs: string[]; title?: string }) => unknown;
  listThreads: (options: { sessionID?: string; roomCode?: string }) => unknown;
  listMessages: (threadId: string, afterSeq?: number, limit?: number) => unknown;
  sendThreadMessage: (input: { threadId: string; senderSessionID: string; message: string; messageType?: string }) => Promise<unknown> | unknown;
  markThreadRead: (input: { threadId: string; sessionID: string; seq: number }) => unknown;
  exportTranscript: (threadId: string) => unknown;
};

export type RelayOpsMcp = {
  server: McpServer;
  toolNames: string[];
  readTaskResource(taskId: string): {
    uri: string;
    mimeType: string;
    text: string;
  };
  getStatus(taskId?: string): {
    activeTaskCount: number;
    task?: unknown;
  };
  replayTask(taskId: string): Promise<unknown> | unknown;
  listRoomMembers(roomCode: string): unknown;
  createThread(input: { roomCode: string; kind: "direct" | "group"; createdBySessionID: string; participantSessionIDs: string[]; title?: string }): unknown;
  listThreads(options: { sessionID?: string; roomCode?: string }): unknown;
  listMessages(threadId: string, afterSeq?: number, limit?: number): unknown;
  sendThreadMessage(input: { threadId: string; senderSessionID: string; message: string; messageType?: string }): Promise<unknown> | unknown;
  markThreadRead(input: { threadId: string; sessionID: string; seq: number }): unknown;
  exportTranscript(threadId: string): unknown;
};

export function createRelayOpsMcpServer(
  taskStore: TaskStore,
  auditStore: AuditStore,
  _roomStore: RoomStore,
  _threadStore: ThreadStore,
  _messageStore: MessageStore,
  handlers: RelayOpsHandlers
): RelayOpsMcp {
  const server = new McpServer({
    name: "relay-ops",
    version: "0.1.0"
  });

  const getStatus = handlers.getStatus ?? ((taskId?: string) => ({
    activeTaskCount: taskStore.listActiveTasks().length,
    task: taskId ? taskStore.getTask(taskId) : undefined
  }));

  const readTaskResource = (taskId: string) => ({
    uri: `relay://task/${taskId}`,
    mimeType: "application/json",
    text: JSON.stringify(
      {
        task: taskStore.getTask(taskId),
        audit: auditStore.list(taskId)
      },
      null,
      2
    )
  });

  const replayTask = (taskId: string) => handlers.replayTask(taskId);
  const listRoomMembers = handlers.listRoomMembers;
  const createThread = handlers.createThread;
  const listThreads = handlers.listThreads;
  const listMessages = handlers.listMessages;
  const sendThreadMessage = handlers.sendThreadMessage;
  const markThreadRead = handlers.markThreadRead;
  const exportTranscript = handlers.exportTranscript;

  server.registerTool("relay-status", { description: "Read relay task status", inputSchema: { taskId: z.string().optional() } }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(getStatus(taskId), null, 2) }] }) as never);
  server.registerTool("relay-replay", { description: "Replay a recoverable relay task", inputSchema: { taskId: z.string() } }, async ({ taskId }) => ({ content: [{ type: "text", text: JSON.stringify(await replayTask(taskId), null, 2) }] }) as never);
  server.registerTool("relay-room-members", { description: "List active room members", inputSchema: { roomCode: z.string() } }, async ({ roomCode }) => ({ content: [{ type: "text", text: JSON.stringify(listRoomMembers(roomCode), null, 2) }] }) as never);
  server.registerTool("relay-thread-create", { description: "Create a durable relay thread", inputSchema: { roomCode: z.string(), kind: z.enum(["direct", "group"]), createdBySessionID: z.string(), participantSessionIDs: z.array(z.string()).min(2), title: z.string().optional() } }, async ({ roomCode, kind, createdBySessionID, participantSessionIDs, title }) => ({ content: [{ type: "text", text: JSON.stringify(createThread({ roomCode, kind, createdBySessionID, participantSessionIDs, title }), null, 2) }] }) as never);
  server.registerTool("relay-thread-list", { description: "List relay threads by session or room", inputSchema: { sessionID: z.string().optional(), roomCode: z.string().optional() } }, async ({ sessionID, roomCode }) => ({ content: [{ type: "text", text: JSON.stringify(listThreads({ sessionID, roomCode }), null, 2) }] }) as never);
  server.registerTool("relay-message-list", { description: "List messages from a relay thread", inputSchema: { threadId: z.string(), afterSeq: z.number().int().optional(), limit: z.number().int().positive().optional() } }, async ({ threadId, afterSeq, limit }) => ({ content: [{ type: "text", text: JSON.stringify(listMessages(threadId, afterSeq, limit), null, 2) }] }) as never);
  server.registerTool("relay-message-send", { description: "Append a durable message into a relay thread", inputSchema: { threadId: z.string(), senderSessionID: z.string(), message: z.string(), messageType: z.string().optional() } }, async ({ threadId, senderSessionID, message, messageType }) => ({ content: [{ type: "text", text: JSON.stringify(await sendThreadMessage({ threadId, senderSessionID, message, messageType }), null, 2) }] }) as never);
  server.registerTool("relay-message-mark-read", { description: "Advance the durable read cursor for a thread participant", inputSchema: { threadId: z.string(), sessionID: z.string(), seq: z.number().int().nonnegative() } }, async ({ threadId, sessionID, seq }) => ({ content: [{ type: "text", text: JSON.stringify(markThreadRead({ threadId, sessionID, seq }), null, 2) }] }) as never);
  server.registerTool("relay-transcript-export", { description: "Export the full durable transcript for a relay thread", inputSchema: { threadId: z.string() } }, async ({ threadId }) => ({ content: [{ type: "text", text: JSON.stringify(exportTranscript(threadId), null, 2) }] }) as never);

  server.resource("relay-task", "relay://task", async () => ({ contents: [{ uri: "relay://task", mimeType: "application/json", text: JSON.stringify(taskStore.listActiveTasks(), null, 2) }] }));

  return {
    server,
    toolNames: [
      "relay-status",
      "relay-replay",
      "relay-room-members",
      "relay-thread-create",
      "relay-thread-list",
      "relay-message-list",
      "relay-message-send",
      "relay-message-mark-read",
      "relay-transcript-export"
    ],
    readTaskResource,
    getStatus,
    replayTask,
    listRoomMembers,
    createThread,
    listThreads,
    listMessages,
    sendThreadMessage,
    markThreadRead,
    exportTranscript
  };
}
