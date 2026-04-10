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
import { AuditStore, type AuditEventRecord } from "../internal/store/audit-store.js";
import { MessageStore, type RelayMessage } from "../internal/store/message-store.js";
import { RelayRoomOrchestrator } from "../internal/orchestration/relay-room-orchestrator.js";
import { RoomStore, type RelayRoom, type RelayRoomKind, type RelayRoomMemberRole } from "../internal/store/room-store.js";
import { SessionLinkStore } from "../internal/store/session-link-store.js";
import { TaskStore, type StoredRelayTask } from "../internal/store/task-store.js";
import { TeamStore, type RelayTeamRun, type RelayTeamRunStatus, type RelayTeamWorker } from "../internal/store/team-store.js";
import { ThreadStore, type RelayThread } from "../internal/store/thread-store.js";
import { buildTaskRelayPrompt, buildThreadRelayPrompt } from "./prompt-preamble.js";
import { evaluateDelivery } from "./delivery-gate.js";
import { HumanGuard } from "./human-guard.js";
import { SessionInjector } from "./injector.js";
import { LoopGuard } from "./loop-guard.js";
import { ResponseObserver } from "./response-observer.js";
import type { SessionRegistry } from "./session-registry.js";
import { isRelayPairAllowed } from "../config.js";
import { classifyRelayWorkflowSignal } from "./team-workflow.js";

type TeamStatusSummary = {
  counts: Record<string, number>;
  healthCounts: Record<string, number>;
};

export type RelayTeamWorkerHealth = "active" | "stale" | "paused" | "unknown" | "settled";

export type RelayTeamWorkerView = RelayTeamWorker & {
  health: RelayTeamWorkerHealth;
  stale: boolean;
  sessionStatus?: SessionStatus["type"];
  sessionUpdatedAt?: number;
};

export type RelayTeamStatusView = {
  runId: string;
  roomCode: string;
  task: string;
  status: RelayTeamRunStatus;
  managerSessionID: string;
  currentSessionRole: string;
  workers: RelayTeamWorkerView[];
  summary: TeamStatusSummary;
  recentEvents: Array<{
    id: number;
    eventType: string;
    payload: Record<string, unknown>;
    createdAt: number;
  }>;
  attentionItems: Array<{
    kind: "stale_worker" | "blocked_worker" | "rejected_signal" | "escalated_issue";
    severity: "high" | "medium";
    targetAlias?: string;
    count?: number;
    reason: string;
    suggestedAction: RelayTeamInterventionAction;
  }>;
  interventionOutcomes: Array<{
    action: RelayTeamInterventionAction;
    targetAlias?: string;
    handoffTo?: string;
    status: "pending" | "acknowledged" | "resolved" | "still_problematic";
    reason: string;
    createdAt: number;
  }>;
  policyDecisions: RelayTeamPolicyDecision[];
  recommendedActions: Array<{
    action: RelayTeamInterventionAction;
    targetAlias?: string;
    handoffTo?: string;
    reason: string;
  }>;
  nextStep: string;
};

export type RelayTeamInterventionAction = "retry" | "reassign" | "unblock" | "nudge";

type RelayTeamPolicyDecision = {
  mode: "observe" | "manual_intervention" | "escalate";
  action?: RelayTeamInterventionAction;
  targetAlias?: string;
  severity: "medium" | "high";
  reason: string;
  requiresExplicitApply: boolean;
  sourceKind: string;
};

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
  static readonly diagnosticsTaskId = "__relay_diagnostics__";
  readonly taskStore: TaskStore;
  readonly auditStore: AuditStore;
  readonly sessionLinkStore: SessionLinkStore;
  readonly roomStore: RoomStore;
  readonly threadStore: ThreadStore;
  readonly messageStore: MessageStore;
  readonly teamStore: TeamStore;
  readonly eventHub = new TaskEventHub();
  readonly humanGuard = new HumanGuard();
  readonly loopGuard = new LoopGuard();
  readonly injector: SessionInjector;
  readonly observer: ResponseObserver;
  readonly sessionRegistry: SessionRegistry;
  readonly relayOrchestrator: RelayRoomOrchestrator;

  private readonly inFlightThreadNotificationKeys = new Set<string>();

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
    this.teamStore = new TeamStore(databasePath);
    this.injector = new SessionInjector(input.client);
    this.observer = new ResponseObserver(this.taskStore, this.auditStore, this.sessionLinkStore, this.eventHub);
    this.relayOrchestrator = new RelayRoomOrchestrator(this.roomStore, this.threadStore, this.messageStore, {
      recordDiagnostic: (eventType, payload) => this.recordDiagnostic(eventType, payload),
      resolveNotificationDecision: (sessionID) => this.resolveNotificationDecision(sessionID),
      notifyPrivateRoomPeer: ({ sourceSessionID, peerSessionID, roomCode, message }) => this.notifyPrivateRoomPeer(sourceSessionID, peerSessionID, roomCode, message),
      notifyThreadParticipant: (thread, sessionID, messages) => this.notifyThreadParticipant(thread, sessionID, messages),
      reserveThreadNotifications: (thread, sessionID, messages) => this.reserveThreadNotifications(thread.threadId, sessionID, messages),
      releaseThreadNotifications: (thread, sessionID, messages) => this.releaseThreadNotifications(thread.threadId, sessionID, messages)
    });

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
    this.teamStore.close();
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

  resolveRoomForSession(sessionID: string, roomCode?: string): RelayRoom {
    return this.relayOrchestrator.resolveRoomForSession(sessionID, roomCode);
  }

  getPeerSessionID(sessionID: string, roomCode?: string): string | undefined {
    return this.relayOrchestrator.getPeerSessionID(sessionID, roomCode);
  }

  createRoom(sessionID: string, kind: RelayRoomKind = "private"): RelayRoom {
    return this.relayOrchestrator.createRoom(sessionID, kind);
  }

  joinRoom(roomCode: string, sessionID: string, alias?: string): RelayRoom {
    const room = this.relayOrchestrator.joinRoom(roomCode, sessionID, alias);
    const worker = this.teamStore.markWorkerJoined(sessionID, room.roomCode, alias);
    if (worker) {
      this.auditStore.append(worker.runId, "team.worker.joined", {
        sessionID,
        alias: worker.alias,
        role: worker.role,
        roomCode: room.roomCode
      });
    }
    return room;
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

  async sendRoomMessage(sourceSessionID: string, message: string, targetAlias?: string, roomCode?: string): Promise<{
    peerSessionID: string;
    roomCode: string;
    threadId: string;
    accepted: boolean;
    reason?: string;
  }> {
    const result = await this.relayOrchestrator.sendRoomMessage(sourceSessionID, message, targetAlias, roomCode);
    const signal = classifyRelayWorkflowSignal(message);
    if (signal.matched && signal.accepted) {
      const worker = this.teamStore.markWorkerSignal(sourceSessionID, result.roomCode, signal);
      if (worker) {
        this.auditStore.append(worker.runId, `team.worker.${signal.status}`, {
          sessionID: sourceSessionID,
          role: worker.role,
          alias: worker.alias,
          roomCode: result.roomCode,
          note: signal.note,
          source: signal.source,
          phase: signal.phase,
          progress: signal.progress,
          evidence: signal.evidence,
          metadata: signal.metadata ?? {}
        });
      }
    } else if (signal.matched) {
      const run = this.teamStore.getRunForSession(sourceSessionID, result.roomCode);
      if (run) {
        const worker = this.teamStore.listWorkers(run.runId).find((entry) => entry.sessionID === sourceSessionID);
        this.auditStore.append(run.runId, "team.worker.signal_rejected", {
          sessionID: sourceSessionID,
          role: worker?.role ?? "manager",
          alias: worker?.alias,
          roomCode: result.roomCode,
          rawMessage: message,
          rejectionReason: signal.rejectionReason ?? "invalid workflow signal"
        });
      }
    }
    return result;
  }

  async interveneTeam(
    managerSessionID: string,
    input: {
      runId?: string;
      roomCode?: string;
      action: RelayTeamInterventionAction;
      targetAlias?: string;
      note: string;
      handoffTo?: string;
      deliverables?: string[];
    }
  ): Promise<{
    runId: string;
    roomCode: string;
    action: RelayTeamInterventionAction;
    targetAlias?: string;
    handoffTo?: string;
    accepted: boolean;
    reason?: string;
    threadId: string;
    peerSessionID: string;
  }> {
    const run = this.teamStore.getRunForSession(managerSessionID, input.roomCode, input.runId);
    if (!run) {
      throw new Error(`No relay workflow team is bound to session ${managerSessionID}.`);
    }
    if (run.managerSessionID !== managerSessionID) {
      throw new Error("Only the manager session can issue team interventions.");
    }

    const note = input.note.trim();
    if (!note) {
      throw new Error("Team intervention requires a non-empty note.");
    }
    if (input.action === "reassign" && !input.handoffTo?.trim()) {
      throw new Error("Reassign intervention requires handoffTo.");
    }

    const payload = {
      action: input.action,
      targetAlias: input.targetAlias,
      note,
      handoffTo: input.handoffTo?.trim() || undefined,
      deliverables: input.deliverables?.filter((item) => item.trim().length > 0) ?? []
    };

    const message = `[TEAM_MANAGER] ${JSON.stringify(payload)}`;
    const result = await this.sendRoomMessage(managerSessionID, message, input.targetAlias, run.roomCode);

    this.auditStore.append(run.runId, "team.manager.intervention", {
      managerSessionID,
      roomCode: run.roomCode,
      action: input.action,
      targetAlias: input.targetAlias,
      note,
      handoffTo: payload.handoffTo,
      deliverables: payload.deliverables,
      accepted: result.accepted,
      reason: result.reason,
      peerSessionID: result.peerSessionID,
      threadId: result.threadId
    });

    return {
      runId: run.runId,
      roomCode: run.roomCode,
      action: input.action,
      targetAlias: input.targetAlias,
      handoffTo: payload.handoffTo,
      accepted: result.accepted,
      reason: result.reason,
      threadId: result.threadId,
      peerSessionID: result.peerSessionID
    };
  }

  async applyTeamPolicy(
    managerSessionID: string,
    input: {
      runId?: string;
      roomCode?: string;
      action: RelayTeamInterventionAction;
      targetAlias?: string;
    }
  ): Promise<{
    applied: boolean;
    runId: string;
    roomCode: string;
    action: RelayTeamInterventionAction;
    targetAlias?: string;
    mode: RelayTeamPolicyDecision["mode"];
    sourceKind: string;
    handoffTo?: string;
    accepted: boolean;
    reason?: string;
    threadId: string;
    peerSessionID: string;
  }> {
    const run = this.teamStore.getRunForSession(managerSessionID, input.roomCode, input.runId);
    if (!run) {
      throw new Error(`No relay workflow team is bound to session ${managerSessionID}.`);
    }

    const decision = this.buildPolicyDecisions(
      this.teamStore.listWorkers(run.runId).map((worker) => this.decorateTeamWorker(worker)),
      this.auditStore.list(run.runId)
    ).find((entry) => entry.action === input.action && entry.targetAlias === input.targetAlias && entry.requiresExplicitApply);

    if (!decision) {
      throw new Error(`No applyable policy decision found for ${input.action}${input.targetAlias ? `:${input.targetAlias}` : ""}.`);
    }

    const applied = await this.interveneTeam(managerSessionID, {
      runId: run.runId,
      roomCode: run.roomCode,
      action: input.action,
      targetAlias: input.targetAlias,
      note: decision.reason
    });

    this.auditStore.append(run.runId, "team.policy.applied", {
      managerSessionID,
      roomCode: run.roomCode,
      action: input.action,
      targetAlias: input.targetAlias,
      mode: decision.mode,
      sourceKind: decision.sourceKind,
      reason: decision.reason
    });

    return {
      applied: true,
      runId: run.runId,
      roomCode: run.roomCode,
      action: input.action,
      targetAlias: input.targetAlias,
      mode: decision.mode,
      sourceKind: decision.sourceKind,
      handoffTo: decision.mode === "escalate" ? input.targetAlias : undefined,
      accepted: applied.accepted,
      reason: applied.reason,
      threadId: applied.threadId,
      peerSessionID: applied.peerSessionID
    };
  }

  getTeamStatus(sessionID: string, runId?: string, roomCode?: string): RelayTeamStatusView {
    const run = this.teamStore.getRunForSession(sessionID, roomCode, runId);
    if (!run) {
      throw new Error(`No relay workflow team is bound to session ${sessionID}.`);
    }

    const workers = this.teamStore.listWorkers(run.runId).map((worker) => this.decorateTeamWorker(worker));
    const currentWorker = workers.find((worker) => worker.sessionID === sessionID);
    const counts = workers.reduce<Record<string, number>>((acc, worker) => {
      acc[worker.status] = (acc[worker.status] ?? 0) + 1;
      return acc;
    }, {});
    const healthCounts = workers.reduce<Record<string, number>>((acc, worker) => {
      acc[worker.health] = (acc[worker.health] ?? 0) + 1;
      return acc;
    }, {});

    const allEvents = this.auditStore.list(run.runId);
    const recentEvents = allEvents.slice(-12);

    return {
      runId: run.runId,
      roomCode: run.roomCode,
      task: run.task,
      status: run.status,
      managerSessionID: run.managerSessionID,
      currentSessionRole: currentWorker?.role ?? "manager",
      workers,
      summary: { counts, healthCounts },
      recentEvents,
      attentionItems: this.buildAttentionItems(workers, allEvents),
      interventionOutcomes: this.buildInterventionOutcomes(workers, allEvents),
      policyDecisions: this.buildPolicyDecisions(workers, allEvents),
      recommendedActions: this.buildRecommendedActions(workers, recentEvents),
      nextStep: this.buildTeamNextStep(run, workers)
    };
  }

  buildTeamCompactionContext(sessionID: string, limit: number): string[] {
    const run = this.teamStore.getRunForSession(sessionID);
    if (!run) {
      return [];
    }

    const workers = this.teamStore.listWorkers(run.runId).slice(0, limit);
    const currentWorker = workers.find((worker) => worker.sessionID === sessionID);
    return [
      "## Team Workflow",
      `Run: ${run.runId}`,
      `Role: ${currentWorker?.role ?? "manager"}`,
      `Room: ${run.roomCode}`,
      `Task: ${run.task}`,
      `Status: ${run.status}`,
      `Recent: ${this.listRecentTeamEvents(run.runId, 3).map((event) => `${event.eventType}:${typeof event.payload.note === "string" ? event.payload.note : ""}`.trim()).join(" | ") || "none"}`,
      `Workers: ${workers.length === 0 ? "none" : workers.map((worker) => {
        const decorated = this.decorateTeamWorker(worker);
        const parts = [
          `${decorated.role}/${decorated.alias}`,
          decorated.status,
          `health=${decorated.health}`,
          decorated.workflowSource ? `source=${decorated.workflowSource}` : undefined,
          decorated.workflowPhase ? `phase=${decorated.workflowPhase}` : undefined,
          decorated.progress !== undefined ? `progress=${decorated.progress}` : undefined,
          decorated.lastNote ? `note=${decorated.lastNote}` : undefined
        ].filter(Boolean);
        return `- ${parts.join(" ")}`;
      }).join("; ")}`
    ];
  }

  async flushPendingForKnownIdleSessions(): Promise<boolean> {
    let notified = false;
    for (const sessionID of this.roomStore.listActiveSessionIDs()) {
      const decision = this.resolveNotificationDecision(sessionID);
      if (!decision.allowed) {
        continue;
      }

      const flushed = await this.notifyPendingMessages(sessionID);
      notified = notified || flushed;
    }
    return notified;
  }

  recordDiagnostic(eventType: string, payload: Record<string, unknown>): void {
    this.auditStore.append(RelayRuntime.diagnosticsTaskId, eventType, payload);
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
    return this.relayOrchestrator.listThreads(options);
  }

  listRoomMembers(roomCodeOrSession: string, sessionID?: string): unknown {
    return this.relayOrchestrator.listRoomMembers(roomCodeOrSession, sessionID);
  }

  setRoomMemberRole(roomCode: string | undefined, actorSessionID: string, targetSessionID: string, role: RelayRoomMemberRole): unknown {
    return this.relayOrchestrator.setRoomMemberRole(roomCode, actorSessionID, targetSessionID, role);
  }

  createThread(input: {
    roomCode?: string;
    kind: "direct" | "group";
    createdBySessionID: string;
    participantSessionIDs: string[];
    title?: string;
  }): RelayThread {
    return this.relayOrchestrator.createThread(input);
  }

  listMessages(threadId: string, afterSeq = 0, limit = 100): RelayMessage[] {
    return this.relayOrchestrator.listMessages(threadId, afterSeq, limit);
  }

  markThreadRead(threadId: string, sessionID: string, seq: number): unknown {
    return this.relayOrchestrator.markThreadRead(threadId, sessionID, seq);
  }

  exportTranscript(threadId: string): unknown {
    return this.relayOrchestrator.exportTranscript(threadId);
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
    return this.relayOrchestrator.sendThreadMessage(input);
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
      this.recordDiagnostic("relay.send.inject", {
        injectorKind: "task-dispatch",
        taskId: task.taskId,
        targetSessionID: sessionID,
        result: "ok"
      });
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
    this.relayOrchestrator.ensureDefaultThreadsForRoom(roomCode);
  }

  private reserveThreadNotifications(threadId: string, sessionID: string, messages: RelayMessage[]): RelayMessage[] {
    const deliverable: RelayMessage[] = [];

    for (const message of messages) {
      const key = `${threadId}:${sessionID}:${message.seq}`;
      if (this.inFlightThreadNotificationKeys.has(key)) {
        continue;
      }
      this.inFlightThreadNotificationKeys.add(key);
      deliverable.push(message);
    }

    return deliverable;
  }

  private releaseThreadNotifications(threadId: string, sessionID: string, messages: RelayMessage[]): void {
    for (const message of messages) {
      this.inFlightThreadNotificationKeys.delete(`${threadId}:${sessionID}:${message.seq}`);
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

        const reservedMessages = this.reserveThreadNotifications(entry.threadId, sessionID, unreadMessages);
        if (reservedMessages.length === 0) {
          break;
        }

        try {
          await this.notifyThreadParticipant(entry, sessionID, reservedMessages);
          const lastDeliveredSeq = reservedMessages[reservedMessages.length - 1]?.seq ?? lastNotifiedSeq;
          this.threadStore.markNotified(entry.threadId, sessionID, lastDeliveredSeq);
          notifiedAny = true;
        } finally {
          this.releaseThreadNotifications(entry.threadId, sessionID, reservedMessages);
        }
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
      return { allowed: true, reason: "session status is unknown; delivery attempted optimistically" };
    }

    return evaluateDelivery(knownStatus);
  }

  private async notifyThreadParticipant(thread: RelayThread, sessionID: string, messages: RelayMessage[]): Promise<void> {
    const roomKind = this.roomStore.getRoom(thread.roomCode)?.kind;
    const senderRoles = Object.fromEntries(
      messages.map((message) => [message.senderSessionID, this.roomStore.getMember(thread.roomCode, message.senderSessionID)?.role as RelayRoomMemberRole | undefined])
    );
    const senderAliases = Object.fromEntries(
      messages.map((message) => [message.senderSessionID, this.roomStore.getMember(thread.roomCode, message.senderSessionID)?.alias])
    );

    const prompt = buildThreadRelayPrompt({
      roomCode: thread.roomCode,
      thread,
      roomKind,
      recipientSessionID: sessionID,
      messages,
      senderRoles,
      senderAliases
    });
    await this.injector.submitAsync(sessionID, prompt);
    this.recordDiagnostic("relay.send.inject", {
      injectorKind: "thread-notify",
      roomCode: thread.roomCode,
      threadId: thread.threadId,
      targetSessionID: sessionID,
      result: "ok"
    });
  }

  private async notifyPrivateRoomPeer(sourceSessionID: string, peerSessionID: string, roomCode: string, message: string): Promise<void> {
    const prompt = [
      "[RELAYED AGENT INPUT]",
      `Sender: paired agent session ${sourceSessionID} (not a human user)`,
      `Room: ${roomCode}`,
      "Response mode: use tools/workflow actions, not end-user chat replies",
      "Message:",
      message
    ].join("\n\n");
    await this.injector.submitAsync(peerSessionID, prompt);
    this.recordDiagnostic("relay.send.inject", {
      injectorKind: "private-room-peer",
      roomCode,
      sourceSessionID,
      targetSessionID: peerSessionID,
      result: "ok"
    });
  }

  private async *streamTaskEvents(id: JsonRpcId, task: Task, events: AsyncIterable<TaskEvent>): AsyncIterable<JsonValue> {
    yield jsonRpcSuccess(id, { task: sanitizePublicTask(task) });
    for await (const event of events) {
      yield { jsonrpc: "2.0", method: "task.event", params: event } as JsonValue;
    }
  }

  private buildTeamNextStep(run: RelayTeamRun, workers: RelayTeamWorkerView[]): string {
    if (run.status === "failed") {
      return "Inspect failed worker notes and decide whether to restart the workflow team.";
    }
    if (run.status === "blocked") {
      return "Inspect blocker notes, unblock the blocked role, and continue coordination through relay room messages.";
    }
    if (run.status === "completed") {
      return "Review the worker completion messages and export the transcript if you need a durable record.";
    }
    if (run.status === "ready") {
      return "The team is assembled and ready. Assign or confirm the next concrete slice of work through relay_room_send or durable relay threads.";
    }
    if (run.status === "in_progress") {
      return "Work is in progress. Monitor relay_team_status for blocker, completion, and health changes before redirecting the team.";
    }

    const staleWorkers = workers.filter((worker) => worker.health === "stale");
    if (staleWorkers.length > 0) {
      return `These workers look stale and may need intervention: ${staleWorkers.map((worker) => worker.alias).join(", ")}.`;
    }

    const waitingWorkers = workers.filter((worker) => ["created", "bootstrapped", "joined"].includes(worker.status));
    if (waitingWorkers.length > 0) {
      return `Wait for remaining workers to join the room and send ${"[TEAM_READY]"} messages: ${waitingWorkers.map((worker) => worker.alias).join(", ")}.`;
    }
    return "Workflow bootstrap is still in progress.";
  }

  private listRecentTeamEvents(runId: string, limit: number): AuditEventRecord[] {
    return this.auditStore.list(runId).slice(-limit);
  }

  private buildRecommendedActions(
    workers: RelayTeamWorkerView[],
    recentEvents: AuditEventRecord[]
  ): Array<{
    action: RelayTeamInterventionAction;
    targetAlias?: string;
    handoffTo?: string;
    reason: string;
  }> {
    const actions: Array<{
      action: RelayTeamInterventionAction;
      targetAlias?: string;
      handoffTo?: string;
      reason: string;
    }> = [];
    const seen = new Set<string>();

    const pushAction = (action: RelayTeamInterventionAction, targetAlias: string | undefined, handoffTo: string | undefined, reason: string) => {
      const key = `${action}:${targetAlias ?? ""}:${handoffTo ?? ""}:${reason}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      actions.push({ action, targetAlias, handoffTo, reason });
    };

    for (const worker of workers) {
      if (worker.health === "stale") {
        pushAction("nudge", worker.alias, undefined, `${worker.alias} looks stale and may need a wake-up check.`);
      }
      if (worker.status === "blocked") {
        pushAction("unblock", worker.alias, undefined, worker.lastNote ? `${worker.alias} is blocked: ${worker.lastNote}` : `${worker.alias} is blocked and needs manager input.`);
      }
    }

    for (const event of recentEvents) {
      if (event.eventType === "team.worker.signal_rejected") {
        const alias = typeof event.payload.alias === "string" ? event.payload.alias : undefined;
        const reason = typeof event.payload.rejectionReason === "string"
          ? event.payload.rejectionReason
          : "worker sent an invalid workflow signal";
        pushAction("retry", alias, undefined, `${alias ?? "worker"} should resend a valid TEAM signal: ${reason}`);
      }

      if (event.eventType === "team.worker.completed") {
        const alias = typeof event.payload.alias === "string" ? event.payload.alias : undefined;
        const metadata = (event.payload.metadata ?? {}) as Record<string, unknown>;
        const handoffTo = typeof metadata.handoffTo === "string" ? metadata.handoffTo : undefined;
        if (handoffTo && handoffTo !== "manager") {
          const deliverables = Array.isArray(metadata.deliverables) ? metadata.deliverables.join(", ") : undefined;
          const reason = deliverables
            ? `${alias ?? "worker"} completed work and suggests handoff to ${handoffTo}: ${deliverables}`
            : `${alias ?? "worker"} completed work and suggests handoff to ${handoffTo}.`;
          pushAction("reassign", alias, handoffTo, reason);
        }
      }
    }

    return actions;
  }

  private buildAttentionItems(
    workers: RelayTeamWorkerView[],
    allEvents: AuditEventRecord[]
  ): Array<{
    kind: "stale_worker" | "blocked_worker" | "rejected_signal" | "escalated_issue";
    severity: "high" | "medium";
    targetAlias?: string;
    count?: number;
    reason: string;
    suggestedAction: RelayTeamInterventionAction;
  }> {
    const items: Array<{
      kind: "stale_worker" | "blocked_worker" | "rejected_signal" | "escalated_issue";
      severity: "high" | "medium";
      targetAlias?: string;
      count?: number;
      reason: string;
      suggestedAction: RelayTeamInterventionAction;
    }> = [];
    const seen = new Set<string>();

    const pushItem = (item: {
      kind: "stale_worker" | "blocked_worker" | "rejected_signal" | "escalated_issue";
      severity: "high" | "medium";
      targetAlias?: string;
      count?: number;
      reason: string;
      suggestedAction: RelayTeamInterventionAction;
    }) => {
      const key = `${item.kind}:${item.targetAlias ?? ""}:${item.reason}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      items.push(item);
    };

    for (const worker of workers) {
      if (worker.health === "stale") {
        pushItem({
          kind: "stale_worker",
          severity: "high",
          targetAlias: worker.alias,
          reason: `${worker.alias} has gone stale and still needs manager attention.`,
          suggestedAction: "nudge"
        });
      }

      if (worker.status === "blocked") {
        pushItem({
          kind: "blocked_worker",
          severity: "high",
          targetAlias: worker.alias,
          reason: worker.lastNote ? `${worker.alias} is blocked: ${worker.lastNote}` : `${worker.alias} is blocked and waiting for intervention.`,
          suggestedAction: "unblock"
        });
      }
    }

    const latestAcceptedByAlias = new Map<string, number>();
    const rejectedCounts = new Map<string, number>();
    const latestRejectedReason = new Map<string, string>();
    const interventionCounts = new Map<string, number>();
    const latestInterventionAction = new Map<string, RelayTeamInterventionAction>();

    for (const event of allEvents) {
      const workerAlias = typeof event.payload.alias === "string" ? event.payload.alias : undefined;

      if (workerAlias && ["team.worker.ready", "team.worker.in_progress", "team.worker.completed", "team.worker.blocked"].includes(event.eventType)) {
        latestAcceptedByAlias.set(workerAlias, event.id);
      }

      if (workerAlias && event.eventType === "team.worker.signal_rejected") {
        rejectedCounts.set(workerAlias, (rejectedCounts.get(workerAlias) ?? 0) + 1);
        if (typeof event.payload.rejectionReason === "string") {
          latestRejectedReason.set(workerAlias, event.payload.rejectionReason);
        }

        const lastAcceptedId = latestAcceptedByAlias.get(workerAlias) ?? 0;
        if (event.id > lastAcceptedId) {
          pushItem({
            kind: "rejected_signal",
            severity: (rejectedCounts.get(workerAlias) ?? 0) >= 2 ? "high" : "medium",
            targetAlias: workerAlias,
            count: rejectedCounts.get(workerAlias),
            reason: `${workerAlias} still has unresolved rejected TEAM signals: ${latestRejectedReason.get(workerAlias) ?? "invalid workflow signal"}`,
            suggestedAction: "retry"
          });
        }
      }

      if (event.eventType === "team.manager.intervention") {
        const targetAlias = typeof event.payload.targetAlias === "string" ? event.payload.targetAlias : undefined;
        const action = typeof event.payload.action === "string" ? event.payload.action as RelayTeamInterventionAction : undefined;
        if (targetAlias && action) {
          interventionCounts.set(targetAlias, (interventionCounts.get(targetAlias) ?? 0) + 1);
          latestInterventionAction.set(targetAlias, action);
        }
      }
    }

    for (const worker of workers) {
      const interventionCount = interventionCounts.get(worker.alias) ?? 0;
      if (interventionCount === 0) {
        continue;
      }

      const latestAction = latestInterventionAction.get(worker.alias) ?? "retry";
      if (worker.health === "stale") {
        pushItem({
          kind: "escalated_issue",
          severity: "high",
          targetAlias: worker.alias,
          count: interventionCount,
          reason: `${worker.alias} is still stale after ${interventionCount} manager intervention(s).`,
          suggestedAction: latestAction === "nudge" ? "reassign" : latestAction
        });
      }

      if (worker.status === "blocked") {
        pushItem({
          kind: "escalated_issue",
          severity: "high",
          targetAlias: worker.alias,
          count: interventionCount,
          reason: `${worker.alias} remains blocked after ${interventionCount} manager intervention(s).`,
          suggestedAction: "reassign"
        });
      }

      const rejectedCount = rejectedCounts.get(worker.alias) ?? 0;
      if (rejectedCount >= 2) {
        pushItem({
          kind: "escalated_issue",
          severity: "high",
          targetAlias: worker.alias,
          count: rejectedCount,
          reason: `${worker.alias} has repeated rejected TEAM signals (${rejectedCount}).`,
          suggestedAction: interventionCount > 0 ? "reassign" : "retry"
        });
      }
    }

    return items;
  }

  private buildInterventionOutcomes(
    workers: RelayTeamWorkerView[],
    allEvents: AuditEventRecord[]
  ): Array<{
    action: RelayTeamInterventionAction;
    targetAlias?: string;
    handoffTo?: string;
    status: "pending" | "acknowledged" | "resolved" | "still_problematic";
    reason: string;
    createdAt: number;
  }> {
    const outcomes: Array<{
      action: RelayTeamInterventionAction;
      targetAlias?: string;
      handoffTo?: string;
      status: "pending" | "acknowledged" | "resolved" | "still_problematic";
      reason: string;
      createdAt: number;
    }> = [];

    const interventionEvents = allEvents.filter((event) => event.eventType === "team.manager.intervention");

    for (let index = 0; index < interventionEvents.length; index += 1) {
      const event = interventionEvents[index]!;
      const payload = event.payload;
      const targetAlias = typeof payload.targetAlias === "string" ? payload.targetAlias : undefined;
      const handoffTo = typeof payload.handoffTo === "string" ? payload.handoffTo : undefined;
      const action = typeof payload.action === "string" ? payload.action as RelayTeamInterventionAction : "retry";
      const nextInterventionId = interventionEvents[index + 1]?.id ?? Number.POSITIVE_INFINITY;
      const followingEvents = allEvents.filter((entry) => entry.id > event.id && entry.id < nextInterventionId);

      let status: "pending" | "acknowledged" | "resolved" | "still_problematic" = "pending";
      let reason = typeof payload.note === "string"
        ? payload.note
        : `manager issued ${action}`;

      const sameAliasEvents = targetAlias
        ? followingEvents.filter((entry) => {
            const alias = typeof entry.payload.alias === "string" ? entry.payload.alias : undefined;
            return alias === targetAlias;
          })
        : [];

      const latestRelevant = sameAliasEvents
        .filter((entry) => [
          "team.worker.ready",
          "team.worker.in_progress",
          "team.worker.completed",
          "team.worker.blocked",
          "team.worker.signal_rejected"
        ].includes(entry.eventType))
        .at(-1);

      if (latestRelevant?.eventType === "team.worker.signal_rejected") {
        status = "still_problematic";
        reason = typeof latestRelevant.payload.rejectionReason === "string"
          ? latestRelevant.payload.rejectionReason
          : `${targetAlias ?? "worker"} still sends invalid TEAM signals after intervention`;
      } else if (latestRelevant && ["team.worker.ready", "team.worker.in_progress", "team.worker.completed"].includes(latestRelevant.eventType)) {
        status = latestRelevant.eventType === "team.worker.completed" ? "resolved" : "acknowledged";
        reason = typeof latestRelevant.payload.note === "string"
          ? latestRelevant.payload.note
          : latestRelevant.eventType === "team.worker.completed"
            ? `${targetAlias ?? "worker"} completed the intervention follow-up`
            : `${targetAlias ?? "worker"} responded with a valid TEAM signal`;
      }

      if (status === "pending" && targetAlias) {
        const worker = workers.find((entry) => entry.alias === targetAlias);
        if (worker?.health === "stale" || worker?.status === "blocked") {
          status = "still_problematic";
          reason = worker.lastNote ?? `${targetAlias} remains ${worker.status === "blocked" ? "blocked" : "stale"}`;
        }
      }

      outcomes.push({
        action,
        targetAlias,
        handoffTo,
        status,
        reason,
        createdAt: event.createdAt
      });
    }

    return outcomes;
  }

  private buildPolicyDecisions(
    workers: RelayTeamWorkerView[],
    allEvents: AuditEventRecord[]
  ): RelayTeamPolicyDecision[] {
    const decisions: RelayTeamPolicyDecision[] = [];
    const seen = new Set<string>();

    const attentionItems = this.buildAttentionItems(workers, allEvents);
    const interventionOutcomes = this.buildInterventionOutcomes(workers, allEvents);

    const pushDecision = (decision: RelayTeamPolicyDecision) => {
      const key = `${decision.mode}:${decision.action ?? ""}:${decision.targetAlias ?? ""}:${decision.reason}`;
      if (seen.has(key)) {
        return;
      }
      seen.add(key);
      decisions.push(decision);
    };

    for (const item of attentionItems) {
      const directlyApplyable = item.suggestedAction !== "reassign";
      pushDecision({
        mode: item.kind === "escalated_issue" ? "escalate" : "manual_intervention",
        action: item.suggestedAction,
        targetAlias: item.targetAlias,
        severity: item.severity,
        reason: item.reason,
        requiresExplicitApply: directlyApplyable,
        sourceKind: item.kind
      });
    }

    for (const outcome of interventionOutcomes) {
      if (outcome.status !== "pending") {
        continue;
      }
      pushDecision({
        mode: "observe",
        action: outcome.action,
        targetAlias: outcome.targetAlias,
        severity: "medium",
        reason: outcome.reason,
        requiresExplicitApply: false,
        sourceKind: "intervention_pending"
      });
    }

    return decisions;
  }

  private decorateTeamWorker(worker: RelayTeamWorker): RelayTeamWorkerView {
    const sessionSnapshot = this.sessionRegistry.get(worker.sessionID);
    const now = Date.now();
    const latestActivityAt = Math.max(worker.updatedAt, sessionSnapshot?.updatedAt ?? 0);
    const stale = !["completed", "failed"].includes(worker.status)
      && now - latestActivityAt > this.config.runtime.teamWorkerStaleAfterMs;

    let health: RelayTeamWorkerHealth;
    if (["completed", "failed"].includes(worker.status)) {
      health = "settled";
    } else if (this.humanGuard.isPaused(worker.sessionID)) {
      health = "paused";
    } else if (stale) {
      health = "stale";
    } else if (sessionSnapshot?.status) {
      health = "active";
    } else {
      health = "unknown";
    }

    return {
      ...worker,
      health,
      stale,
      sessionStatus: sessionSnapshot?.status?.type,
      sessionUpdatedAt: sessionSnapshot?.updatedAt
    };
  }
}
