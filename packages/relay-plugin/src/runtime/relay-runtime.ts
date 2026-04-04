import { existsSync } from "node:fs";
import { join } from "node:path";

import type { PluginInput } from "@opencode-ai/plugin";
import { type Artifact, jsonRpcRequestSchema, type JsonRpcId, type JsonRpcRequest, type Message, type Part, type Task, type TaskEvent } from "@opencode-peer-session-relay/a2a-protocol";
import type { SessionStatus } from "@opencode-ai/sdk";

import { buildRelayAgentCard } from "../a2a/agent-card.js";
import { createCancelTaskHandler } from "../a2a/handlers/cancel-task.js";
import { createGetTaskHandler } from "../a2a/handlers/get-task.js";
import { createSendMessageHandler } from "../a2a/handlers/send-message.js";
import { createSendMessageStreamHandler } from "../a2a/handlers/send-message-stream.js";
import { cancelTaskParamsSchema, getTaskParamsSchema, type InboundRelayRequest } from "../a2a/mapper/inbound-request.js";
import { mapTaskStatusEvent, TaskEventHub } from "../a2a/mapper/outbound-events.js";
import type { A2AHostResponse, JsonValue } from "../a2a/host.js";
import type { RelayPluginConfig } from "../config.js";
import { createRelayOpsMcpServer, type RelayOpsMcp } from "../internal/mcp/server.js";
import { AuditStore } from "../internal/store/audit-store.js";
import { MessageStore, type RelayMessage } from "../internal/store/message-store.js";
import { RoomStore, type RelayRoomKind, type RelayRoomMemberRole } from "../internal/store/room-store.js";
import { SessionLinkStore } from "../internal/store/session-link-store.js";
import { TaskStore, type StoredRelayTask } from "../internal/store/task-store.js";
import { ThreadStore, type RelayThread } from "../internal/store/thread-store.js";
import { buildTaskRelayPrompt, buildThreadRelayPrompt } from "./prompt-preamble.js";
import { evaluateDelivery } from "./delivery-gate.js";
import { HumanGuard } from "./human-guard.js";
import { SessionInjector } from "./injector.js";
import { LoopGuard } from "./loop-guard.js";
import { ResponseObserver } from "./response-observer.js";
import type { SessionRegistry } from "./session-registry.js";
import { isRelayPairAllowed } from "../config.js";

function jsonRpcSuccess(id: JsonRpcId, result: JsonValue): JsonValue {
  return { jsonrpc: "2.0", id, result };
}

function jsonRpcError(id: JsonRpcId | null, code: number, message: string, data?: JsonValue): JsonValue {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
      data: data ?? null
    }
  };
}

function renderMessagePart(message: Message): string {
  return message.parts
    .map((part) => {
      if ("text" in part) return part.text;
      if ("data" in part) return JSON.stringify(part.data, null, 2);
      if ("url" in part) return `Resource URL: ${part.url}`;
      return part.raw;
    })
    .join("\n\n");
}

function isTaskForSession(task: StoredRelayTask, sessionID: string): boolean {
  return task.metadata.sessionID === sessionID;
}

function sanitizePart(part: Part): Part {
  return { ...part, metadata: {} };
}

function sanitizeMessage(message: Message | undefined): JsonValue {
  if (!message) return null;
  return {
    ...message,
    metadata: {},
    parts: message.parts.map((part) => sanitizePart(part))
  } as JsonValue;
}

function sanitizeArtifact(artifact: Artifact): JsonValue {
  return {
    ...artifact,
    metadata: {},
    parts: artifact.parts.map((part) => sanitizePart(part))
  } as JsonValue;
}

function sanitizePublicTask(task: Task | StoredRelayTask | null): JsonValue {
  if (!task) return null;
  return {
    ...task,
    metadata: {},
    latestMessage: sanitizeMessage(task.latestMessage) as Task["latestMessage"],
    history: task.history.map((message) => sanitizeMessage(message)) as Task["history"],
    artifacts: task.artifacts.map((artifact) => sanitizeArtifact(artifact)) as Task["artifacts"]
  } as JsonValue;
}

export class RelayRuntime {
  readonly taskStore: TaskStore;
  readonly auditStore: AuditStore;
  readonly sessionLinkStore: SessionLinkStore;
  readonly roomStore: RoomStore;
  readonly threadStore: ThreadStore;
  readonly messageStore: MessageStore;
  readonly eventHub = new TaskEventHub();
  readonly humanGuard = new HumanGuard();
  readonly loopGuard = new LoopGuard();
  readonly injector: SessionInjector;
  readonly observer: ResponseObserver;
  readonly sessionRegistry: SessionRegistry;

  private readonly sendMessage;
  private readonly sendMessageStream;
  private readonly getTask;
  private readonly cancelTask;

  constructor(
    private readonly input: PluginInput,
    private readonly config: RelayPluginConfig,
    sessionRegistry: SessionRegistry
  ) {
    this.sessionRegistry = sessionRegistry;
    const databasePath = config.runtime.databasePath ?? (existsSync(input.directory) ? join(input.directory, ".opencode-a2a-relay.sqlite") : ":memory:");
    this.taskStore = new TaskStore(databasePath);
    this.auditStore = new AuditStore(databasePath);
    this.sessionLinkStore = new SessionLinkStore(databasePath);
    this.roomStore = new RoomStore(databasePath);
    this.threadStore = new ThreadStore(databasePath);
    this.messageStore = new MessageStore(databasePath);
    this.injector = new SessionInjector(input.client);
    this.observer = new ResponseObserver(this.taskStore, this.auditStore, this.sessionLinkStore, this.eventHub);

    const sendMessageDependencies = {
      taskStore: this.taskStore,
      auditStore: this.auditStore,
      sessionLinkStore: this.sessionLinkStore,
      eventHub: this.eventHub,
      humanGuard: this.humanGuard,
      loopGuard: this.loopGuard,
      routeGuard: async (request: InboundRelayRequest) => this.assertRouteAllowed(request),
      executor: {
        dispatch: async (request: InboundRelayRequest & { taskId: string }) => this.dispatchTask(request)
      }
    };

    this.sendMessage = createSendMessageHandler(sendMessageDependencies);
    this.sendMessageStream = createSendMessageStreamHandler(sendMessageDependencies, this.eventHub);
    this.getTask = createGetTaskHandler(this.taskStore);
    this.cancelTask = createCancelTaskHandler(this.taskStore, this.auditStore, this.eventHub);
  }

  close(): void {
    this.taskStore.close();
    this.auditStore.close();
    this.roomStore.close();
    this.threadStore.close();
    this.messageStore.close();
    this.sessionLinkStore.close();
  }

  buildAgentCard(url?: string): JsonValue {
    return buildRelayAgentCard({ config: this.config, version: "0.1.0", url }) as unknown as JsonValue;
  }

  createInternalOpsMcp(): RelayOpsMcp {
    return createRelayOpsMcpServer(this.taskStore, this.auditStore, this.roomStore, this.threadStore, this.messageStore, {
      replayTask: async (taskId) => this.replayTask(taskId),
      listRoomMembers: (roomCode) => this.listRoomMembers(roomCode),
      createThread: (input) => this.createThread(input),
      listThreads: ({ sessionID, roomCode }) => this.listThreads({ sessionID, roomCode }),
      listMessages: (threadId, afterSeq, limit) => this.listMessages(threadId, afterSeq, limit),
      sendThreadMessage: async (input) => this.sendThreadMessage(input),
      markThreadRead: ({ threadId, sessionID, seq }) => this.markThreadRead(threadId, sessionID, seq),
      exportTranscript: (threadId) => this.exportTranscript(threadId)
    });
  }

  async handleJsonRpc(payload: unknown): Promise<A2AHostResponse> {
    const parsedRequest = jsonRpcRequestSchema.safeParse(payload);
    if (!parsedRequest.success) {
      return { kind: "json", statusCode: 400, body: jsonRpcError(null, -32600, "Invalid JSON-RPC request", parsedRequest.error.flatten() as unknown as JsonValue) };
    }

    const request = parsedRequest.data;

    try {
      switch (request.method) {
        case "sendMessage": {
          const task = await this.sendMessage(request);
          return { kind: "json", body: jsonRpcSuccess(request.id, { task: sanitizePublicTask(task) }) };
        }
        case "sendMessageStream": {
          const streamRequest: JsonRpcRequest = { ...request, method: "sendMessage" };
          const result = await this.sendMessageStream(streamRequest);
          return { kind: "sse", events: this.streamTaskEvents(request.id, result.task, result.events) };
        }
        case "getTask": {
          const params = getTaskParamsSchema.parse(request.params ?? {});
          const task = this.getTask(params.taskId) ?? null;
          return { kind: "json", body: jsonRpcSuccess(request.id, { task: sanitizePublicTask(task) }) };
        }
        case "cancelTask": {
          const params = cancelTaskParamsSchema.parse(request.params ?? {});
          const task = this.cancelTask(params.taskId);
          return { kind: "json", body: jsonRpcSuccess(request.id, { task: sanitizePublicTask(task) }) };
        }
        default:
          return { kind: "json", statusCode: 404, body: jsonRpcError(request.id, -32601, `Unsupported method: ${request.method}`) };
      }
    } catch (error) {
      return { kind: "json", statusCode: 500, body: jsonRpcError(request.id, -32603, error instanceof Error ? error.message : "Internal server error") };
    }
  }

  async onSessionStatus(sessionID: string, status: SessionStatus): Promise<void> {
    this.sessionRegistry.upsert({ sessionID, status, updatedAt: Date.now() });

    if (status.type === "idle" && !this.humanGuard.isPaused(sessionID)) {
      const notified = await this.notifyPendingMessages(sessionID);
      if (notified) {
        return;
      }
    }

    const nextTask = this.taskStore
      .listActiveTasks()
      .filter((task) => task.status === "submitted" && isTaskForSession(task, sessionID))
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];

    if (status.type !== "idle") {
      if (nextTask) {
        this.observer.updateStatus(nextTask.taskId, "working");
      }
      return;
    }

    if (this.humanGuard.isPaused(sessionID) || !nextTask) {
      return;
    }

    await this.dispatchStoredTask(nextTask, sessionID);
  }

  async sendRoomMessage(sourceSessionID: string, message: string, targetAlias?: string): Promise<{
    peerSessionID: string;
    roomCode: string;
    threadId: string;
    accepted: boolean;
    reason?: string;
  }> {
    const room = this.roomStore.getRoomBySession(sourceSessionID);
    if (!room) {
      throw new Error(`No relay room is bound to session ${sourceSessionID}.`);
    }

    const actor = this.roomStore.getMember(room.roomCode, sourceSessionID);
    if (!actor || actor.role === "observer") {
      throw new Error(`Session ${sourceSessionID} is not allowed to send room messages in room ${room.roomCode}.`);
    }

    if (room.kind === "group") {
      if (targetAlias) {
        const target = this.roomStore.getMemberByAlias(room.roomCode, targetAlias);
        if (!target) {
          throw new Error(`Alias ${targetAlias} does not exist in room ${room.roomCode}.`);
        }
        const thread = this.threadStore.ensureDirectThread(room.roomCode, [sourceSessionID, target.sessionID], sourceSessionID);
        const result = await this.sendThreadMessage({ threadId: thread.threadId, senderSessionID: sourceSessionID, message, messageType: "relay" });
        return {
          peerSessionID: target.sessionID,
          roomCode: room.roomCode,
          threadId: thread.threadId,
          accepted: true,
          reason: result.queuedRecipients.find((entry) => entry.sessionID === target.sessionID)?.reason
        };
      }

      const groupThread = this.threadStore.ensureGroupThread(room.roomCode, this.roomStore.getMemberSessionIDs(room.roomCode), this.roomStore.getOwner(room.roomCode).sessionID, "room-main");
      const result = await this.sendThreadMessage({ threadId: groupThread.threadId, senderSessionID: sourceSessionID, message, messageType: "relay" });
      return {
        peerSessionID: "group",
        roomCode: room.roomCode,
        threadId: groupThread.threadId,
        accepted: true,
        reason: result.queuedRecipients.length > 0 ? "some members are currently queued" : undefined
      };
    }

    const activeWritableMembers = this.roomStore.listWritableMembers(room.roomCode);
    if (activeWritableMembers.length > 2) {
      throw new Error(`Room ${room.roomCode} has multiple active members; use relay_thread_create and relay_message_send for multi-agent messaging.`);
    }

    const peerSessionID = this.roomStore.getPeerSessionID(sourceSessionID);
    if (!peerSessionID) {
      throw new Error(`Room ${room.roomCode} does not have a connected peer yet.`);
    }

    const thread = this.threadStore.ensureDirectThread(room.roomCode, [sourceSessionID, peerSessionID], sourceSessionID);
    const result = await this.sendThreadMessage({ threadId: thread.threadId, senderSessionID: sourceSessionID, message, messageType: "relay" });

    return {
      peerSessionID,
      roomCode: room.roomCode,
      threadId: thread.threadId,
      accepted: true,
      reason: result.queuedRecipients.find((entry) => entry.sessionID === peerSessionID)?.reason
    };
  }

  async replayTask(taskId: string): Promise<StoredRelayTask | undefined> {
    const existing = this.taskStore.getTask(taskId);
    if (!existing) return undefined;
    if (!["failed", "canceled"].includes(existing.status)) {
      throw new Error(`Task ${taskId} is not replayable from status ${existing.status}.`);
    }

    const replayed = this.taskStore.updateStatus(taskId, "submitted", existing.latestMessage);
    this.auditStore.append(taskId, "task.replayed", {});
    this.eventHub.emit(taskId, mapTaskStatusEvent(replayed));

    const sessionID = this.sessionLinkStore.getSessionID(taskId) ?? (typeof replayed.metadata.sessionID === "string" ? replayed.metadata.sessionID : undefined);
    if (!sessionID) return replayed;

    if (this.sessionRegistry.get(sessionID)?.status?.type === "idle" && !this.humanGuard.isPaused(sessionID)) {
      await this.dispatchStoredTask(replayed, sessionID);
      return this.taskStore.getTask(taskId);
    }

    return replayed;
  }

  listThreads(options: { sessionID?: string; roomCode?: string }): unknown {
    if (options.roomCode) {
      return this.threadStore.listThreadsForRoom(options.roomCode).map((thread) => this.decorateThread(thread));
    }
    if (options.sessionID) {
      return this.threadStore.listThreadsForSession(options.sessionID).map(({ participant, ...thread }) => ({
        ...this.decorateThread(thread),
        participant
      }));
    }
    return [];
  }

  listRoomMembers(roomCode: string): unknown {
    return this.roomStore.listMembers(roomCode);
  }

  setRoomMemberRole(roomCode: string, actorSessionID: string, targetSessionID: string, role: RelayRoomMemberRole): unknown {
    const actor = this.roomStore.getMember(roomCode, actorSessionID);
    if (!actor || actor.role !== "owner") {
      throw new Error(`Only the room owner can change member roles in room ${roomCode}.`);
    }

    const updated = this.roomStore.setMemberRole(roomCode, targetSessionID, role);
    this.ensureDefaultThreadsForRoom(roomCode);
    return updated;
  }

  createThread(input: {
    roomCode: string;
    kind: "direct" | "group";
    createdBySessionID: string;
    participantSessionIDs: string[];
    title?: string;
  }): RelayThread {
    const room = this.roomStore.getRoom(input.roomCode);
    if (!room) {
      throw new Error(`Room ${input.roomCode} does not exist.`);
    }

    const actor = this.roomStore.getMember(input.roomCode, input.createdBySessionID);
    if (!actor || actor.role === "observer") {
      throw new Error(`Session ${input.createdBySessionID} is not allowed to create threads in room ${input.roomCode}.`);
    }

    const memberIDs = new Set(this.roomStore.getMemberSessionIDs(input.roomCode));
    for (const participantSessionID of input.participantSessionIDs) {
      if (!memberIDs.has(participantSessionID)) {
        throw new Error(`Session ${participantSessionID} is not an active member of room ${input.roomCode}.`);
      }
    }

    if (!input.participantSessionIDs.includes(input.createdBySessionID)) {
      throw new Error(`Thread creator ${input.createdBySessionID} must be part of the thread participants.`);
    }

    if (room.kind === "private") {
      if (input.kind !== "direct") {
        throw new Error(`Private rooms only allow direct threads.`);
      }
      const owner = this.roomStore.getOwner(input.roomCode);
      if (input.participantSessionIDs.length !== 2) {
        throw new Error(`Direct threads must contain exactly 2 participants.`);
      }
      if (!input.participantSessionIDs.includes(owner.sessionID)) {
        throw new Error(`Direct threads must include the room owner ${owner.sessionID}.`);
      }
      return this.threadStore.ensureDirectThread(input.roomCode, input.participantSessionIDs, input.createdBySessionID);
    }

    if (input.kind === "group") {
      if (actor.role !== "owner") {
        throw new Error(`Only the room owner can create group threads in room ${input.roomCode}.`);
      }
      return this.threadStore.createGroupThread(input.roomCode, input.participantSessionIDs, input.createdBySessionID, input.title);
    }

    const writableMemberIDs = new Set(this.roomStore.listWritableMembers(input.roomCode).map((member) => member.sessionID));
    if (input.participantSessionIDs.length !== 2) {
      throw new Error(`Direct threads must contain exactly 2 participants.`);
    }
    for (const participantSessionID of input.participantSessionIDs) {
      if (!writableMemberIDs.has(participantSessionID)) {
        throw new Error(`Direct threads in group rooms require writable members only.`);
      }
    }

    return this.threadStore.ensureDirectThread(input.roomCode, input.participantSessionIDs, input.createdBySessionID);
  }

  listMessages(threadId: string, afterSeq = 0, limit = 100): RelayMessage[] {
    return this.messageStore.listMessages(threadId, afterSeq, limit);
  }

  markThreadRead(threadId: string, sessionID: string, seq: number): unknown {
    return this.threadStore.markRead(threadId, sessionID, seq);
  }

  exportTranscript(threadId: string): unknown {
    const thread = this.threadStore.getThread(threadId);
    if (!thread) {
      throw new Error(`Thread ${threadId} does not exist.`);
    }
    return this.messageStore.exportTranscript(thread, this.threadStore.listParticipants(threadId));
  }

  async sendThreadMessage(input: {
    threadId: string;
    senderSessionID: string;
    message: string;
    messageType?: string;
  }): Promise<{
    threadId: string;
    seq: number;
    notifiedRecipients: string[];
    queuedRecipients: Array<{ sessionID: string; reason: string }>;
  }> {
    const thread = this.threadStore.getThread(input.threadId);
    if (!thread) {
      throw new Error(`Thread ${input.threadId} does not exist.`);
    }

    const senderParticipant = this.threadStore.getParticipant(input.threadId, input.senderSessionID);
    if (!senderParticipant) {
      throw new Error(`Sender ${input.senderSessionID} is not part of thread ${input.threadId}.`);
    }

    const senderRole = this.roomStore.getMember(thread.roomCode, input.senderSessionID)?.role;
    if (!senderRole || senderRole === "observer") {
      throw new Error(`Session ${input.senderSessionID} is not allowed to send messages in thread ${input.threadId}.`);
    }

    const message = this.messageStore.appendMessage({
      threadId: input.threadId,
      senderSessionID: input.senderSessionID,
      messageType: input.messageType ?? "relay",
      body: { text: input.message }
    });
    this.threadStore.touchThread(input.threadId);
    this.threadStore.markRead(input.threadId, input.senderSessionID, message.seq);
    this.threadStore.markNotified(input.threadId, input.senderSessionID, message.seq);

    const queuedRecipients: Array<{ sessionID: string; reason: string }> = [];
    const notifiedRecipients: string[] = [];
    for (const participant of this.threadStore.listParticipants(input.threadId)) {
      if (participant.sessionID === input.senderSessionID) continue;

      const decision = this.resolveNotificationDecision(participant.sessionID);
      if (!decision.allowed) {
        queuedRecipients.push({ sessionID: participant.sessionID, reason: decision.reason });
        continue;
      }

      await this.notifyThreadParticipant(thread, participant.sessionID, [message]);
      this.threadStore.markNotified(input.threadId, participant.sessionID, message.seq);
      notifiedRecipients.push(participant.sessionID);
    }

    return {
      threadId: input.threadId,
      seq: message.seq,
      notifiedRecipients,
      queuedRecipients
    };
  }

  private async dispatchTask(request: InboundRelayRequest & { taskId: string }): Promise<{ sessionID?: string }> {
    const task = this.taskStore.getTask(request.taskId);
    if (!task) throw new Error(`Task not found: ${request.taskId}`);

    const sessionID = request.sessionID ?? (typeof task.metadata.sessionID === "string" ? task.metadata.sessionID : undefined);
    if (!sessionID) throw new Error("sessionID is required to dispatch a relay task.");

    return this.dispatchStoredTask(task, sessionID);
  }

  private async dispatchStoredTask(task: StoredRelayTask, sessionID: string): Promise<{ sessionID: string }> {
    const decision = evaluateDelivery(this.sessionRegistry.get(sessionID)?.status);
    if (!decision.allowed) {
      this.auditStore.append(task.taskId, "task.deferred", { sessionID, reason: decision.reason });
      return { sessionID };
    }

    try {
      const requestMessage = task.history[0];
      const content = requestMessage ? renderMessagePart(requestMessage) : "";
      const prompt = buildTaskRelayPrompt({
        sourceSessionID: typeof task.metadata.sourceSessionID === "string" ? task.metadata.sourceSessionID : undefined,
        taskId: task.taskId,
        contextId: task.contextId,
        content
      });
      await this.injector.submitAsync(sessionID, prompt);
      this.observer.accept(task.taskId, sessionID);
      this.auditStore.append(task.taskId, "task.dispatched", { sessionID });
      return { sessionID };
    } catch (error) {
      this.auditStore.append(task.taskId, "task.dispatch_failed", {
        sessionID,
        message: error instanceof Error ? error.message : "unknown error"
      });
      this.taskStore.updateStatus(task.taskId, "failed");
      throw error;
    }
  }

  private assertRouteAllowed(request: InboundRelayRequest): void {
    if (isRelayPairAllowed(this.config, request.sourceSessionID, request.sessionID)) return;
    if (request.sourceSessionID && request.sessionID && this.roomStore.areSessionsPaired(request.sourceSessionID, request.sessionID)) return;

    throw new Error(
      this.config.routing.mode === "pair"
        ? `Relay pair is not allowed: ${request.sourceSessionID ?? "unknown-source"} -> ${request.sessionID ?? "unknown-target"}`
        : "Relay route is not allowed"
    );
  }

  ensureDefaultThreadsForRoom(roomCode: string): void {
    const room = this.roomStore.getRoom(roomCode);
    const owner = this.roomStore.getOwner(roomCode);
    const activeMembers = this.roomStore.listMembers(roomCode);
    const writableMembers = activeMembers.filter((member) => member.role !== "observer");

    if (room?.kind === "group") {
      this.threadStore.ensureGroupThread(roomCode, activeMembers.map((member) => member.sessionID), owner.sessionID, "room-main");
    }

    for (const member of writableMembers) {
      if (member.sessionID === owner.sessionID) {
        continue;
      }
      this.threadStore.ensureDirectThread(roomCode, [owner.sessionID, member.sessionID], owner.sessionID);
    }
  }

  private async notifyPendingMessages(sessionID: string): Promise<boolean> {
    let notifiedAny = false;
    const threadEntries = this.threadStore.listThreadsForSession(sessionID);

    for (const entry of threadEntries) {
      while (true) {
        const latestSeq = this.messageStore.getLatestSeq(entry.threadId);
        const currentParticipant = this.threadStore.getParticipant(entry.threadId, sessionID);
        const lastNotifiedSeq = currentParticipant?.lastNotifiedSeq ?? 0;

        if (latestSeq <= lastNotifiedSeq) {
          break;
        }

        const unreadMessages = this.messageStore
          .listMessages(entry.threadId, lastNotifiedSeq, 50)
          .filter((message) => message.senderSessionID !== sessionID);

        if (unreadMessages.length === 0) {
          this.threadStore.markNotified(entry.threadId, sessionID, latestSeq);
          break;
        }

        await this.notifyThreadParticipant(entry, sessionID, unreadMessages);
        const lastDeliveredSeq = unreadMessages[unreadMessages.length - 1]?.seq ?? lastNotifiedSeq;
        this.threadStore.markNotified(entry.threadId, sessionID, lastDeliveredSeq);
      notifiedAny = true;
      }
    }

    return notifiedAny;
  }

  private resolveNotificationDecision(sessionID: string): { allowed: boolean; reason: string } {
    if (this.humanGuard.isPaused(sessionID)) {
      return { allowed: false, reason: this.humanGuard.reason(sessionID) ?? "peer session is paused by human takeover" };
    }

    const knownStatus = this.sessionRegistry.get(sessionID)?.status;
    if (!knownStatus) {
      return { allowed: false, reason: "session status is unknown" };
    }

    return evaluateDelivery(knownStatus);
  }

  private async notifyThreadParticipant(thread: RelayThread, sessionID: string, messages: RelayMessage[]): Promise<void> {
    const senderRoles = Object.fromEntries(
      messages.map((message) => [message.senderSessionID, this.roomStore.getMember(thread.roomCode, message.senderSessionID)?.role as RelayRoomMemberRole | undefined])
    );
    const senderAliases = Object.fromEntries(
      messages.map((message) => [message.senderSessionID, this.roomStore.getMember(thread.roomCode, message.senderSessionID)?.alias])
    );

    const prompt = buildThreadRelayPrompt({
      roomCode: thread.roomCode,
      thread,
      recipientSessionID: sessionID,
      messages,
      senderRoles,
      senderAliases
    });
    await this.injector.submitAsync(sessionID, prompt);
  }

  private decorateThread(thread: RelayThread): RelayThread & { latestSeq: number; participantCount: number } {
    return {
      ...thread,
      latestSeq: this.messageStore.getLatestSeq(thread.threadId),
      participantCount: this.threadStore.listParticipants(thread.threadId).length
    };
  }

  private async *streamTaskEvents(id: JsonRpcId, task: Task, events: AsyncIterable<TaskEvent>): AsyncIterable<JsonValue> {
    yield jsonRpcSuccess(id, { task: sanitizePublicTask(task) });
    for await (const event of events) {
      yield { jsonrpc: "2.0", method: "task.event", params: event } as JsonValue;
    }
  }
}
