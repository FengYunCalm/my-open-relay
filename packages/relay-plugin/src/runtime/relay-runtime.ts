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
import { TeamStore } from "../internal/store/team-store.js";
import { ThreadStore, type RelayThread } from "../internal/store/thread-store.js";
import { buildTaskRelayPrompt, buildThreadRelayPrompt } from "./prompt-preamble.js";
import { evaluateDelivery } from "./delivery-gate.js";
import { HumanGuard } from "./human-guard.js";
import { SessionInjector } from "./injector.js";
import { LoopGuard } from "./loop-guard.js";
import { ResponseObserver } from "./response-observer.js";
import {
  type RelayTeamInterventionAction,
  type RelayTeamPolicyDecision,
  type RelayTeamStatusView,
  TeamStatusService
} from "./team-status-service.js";
import type { SessionRegistry } from "./session-registry.js";
import { isRelayPairAllowed } from "../config.js";
import { classifyRelayWorkflowSignal } from "./team-workflow.js";

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

function getAcceptedDispatchSessionID(task: StoredRelayTask): string | undefined {
  return typeof task.metadata.relayDispatchSessionID === "string"
    ? task.metadata.relayDispatchSessionID
    : undefined;
}

function isTaskDispatchAccepted(task: StoredRelayTask, sessionID?: string): boolean {
  const acceptedSessionID = getAcceptedDispatchSessionID(task);
  if (!acceptedSessionID) {
    return false;
  }
  return sessionID ? acceptedSessionID === sessionID : true;
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
  readonly teamStatusService: TeamStatusService;

  private readonly inFlightTaskDispatches = new Set<string>();
  private readonly inFlightThreadNotificationKeys = new Set<string>();
  private readonly lastInjectedThreadSeqByRecipient = new Map<string, number>();
  private readonly lastManagerThreadPromptByRecipient = new Map<string, string>();

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
    this.teamStatusService = new TeamStatusService({
      teamStore: this.teamStore,
      auditStore: this.auditStore,
      sessionRegistry: this.sessionRegistry,
      humanGuard: this.humanGuard,
      teamWorkerStaleAfterMs: this.config.runtime.teamWorkerStaleAfterMs
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
      getStatus: (taskId) => this.getOperationsStatus(taskId),
      getDiagnostics: (limit) => this.getRecentDiagnostics(limit),
      pauseSession: (sessionID, reason) => this.pauseAutomation(sessionID, reason),
      resumeSession: (sessionID) => this.resumeAutomation(sessionID),
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

  createRoom(sessionID: string, kind: RelayRoomKind = "private", options?: { reuseExisting?: boolean }): RelayRoom {
    return this.relayOrchestrator.createRoom(sessionID, kind, options);
  }

  joinRoom(roomCode: string, sessionID: string, alias?: string): RelayRoom {
    return this.roomStore.transaction(() => {
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
    });
  }

  async onSessionStatus(sessionID: string, status: SessionStatus): Promise<void> {
    this.sessionRegistry.upsert({ sessionID, status, updatedAt: Date.now() });

    const acceptedTask = this.taskStore
      .listActiveTasks()
      .filter((task) => task.status === "submitted" && isTaskDispatchAccepted(task, sessionID))
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];

    if (status.type !== "idle") {
      if (acceptedTask) {
        this.taskStore.transaction(() => {
          this.observer.updateStatus(acceptedTask.taskId, "working");
          this.taskStore.mergeMetadata(acceptedTask.taskId, {
            relayDispatchSessionID: undefined,
            relayDispatchAcceptedAt: undefined
          });
        });
      }
      return;
    }

    if (status.type === "idle" && !this.humanGuard.isPaused(sessionID)) {
      const notified = await this.notifyPendingMessages(sessionID);
      if (notified) {
        return;
      }
    }

    const nextTask = this.taskStore
      .listActiveTasks()
      .filter((task) => (
        task.status === "submitted"
        && isTaskForSession(task, sessionID)
        && !isTaskDispatchAccepted(task)
        && !this.inFlightTaskDispatches.has(task.taskId)
      ))
      .sort((left, right) => left.updatedAt - right.updatedAt)[0];

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
      try {
        this.teamStore.transaction(() => {
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
        });
      } catch (error) {
        this.recordRejectedTeamSignal(sourceSessionID, result.roomCode, message, error instanceof Error ? error.message : "invalid workflow transition");
      }
    } else if (signal.matched) {
      this.recordRejectedTeamSignal(sourceSessionID, result.roomCode, message, signal.rejectionReason ?? "invalid workflow signal");
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
    const access = this.teamStore.getRunAccess(managerSessionID, input.roomCode, input.runId);
    if (!access) {
      throw new Error(`No relay workflow team is bound to session ${managerSessionID}.`);
    }
    if (access.role !== "manager") {
      throw new Error("Only the manager session can issue team interventions.");
    }
    const run = access.run;

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
    const access = this.teamStore.getRunAccess(managerSessionID, input.roomCode, input.runId);
    if (!access) {
      throw new Error(`No relay workflow team is bound to session ${managerSessionID}.`);
    }
    if (access.role !== "manager") {
      throw new Error("Only the manager session can apply team policies.");
    }
    const run = access.run;

    const decision = this.teamStatusService
      .getTeamStatus(managerSessionID, run.runId, run.roomCode)
      .policyDecisions
      .find((entry) => entry.action === input.action && entry.targetAlias === input.targetAlias && entry.requiresExplicitApply);

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

  async cleanupTeam(
    managerSessionID: string,
    input: {
      runId?: string;
      roomCode?: string;
      targetAlias?: string;
      force?: boolean;
    }
  ): Promise<{
    runId: string;
    roomCode: string;
    runStatus: string;
    targetAlias?: string;
    force: boolean;
    cleaned: Array<{ sessionID: string; alias: string; role: string; cleanedUpAt?: number; reason: string }>;
    alreadyCleaned: Array<{ sessionID: string; alias: string; role: string; cleanedUpAt?: number }>;
    failed: Array<{ sessionID: string; alias: string; role: string; error: string }>;
    nextStep: string;
  }> {
    const access = this.teamStore.getRunAccess(managerSessionID, input.roomCode, input.runId);
    if (!access) {
      throw new Error(`No relay workflow team is bound to session ${managerSessionID}.`);
    }
    if (access.role !== "manager") {
      throw new Error("Only the manager session can clean up team worker sessions.");
    }

    const run = access.run;
    if (!input.force && !["completed", "failed", "cleaned_up"].includes(run.status)) {
      throw new Error("Team cleanup only runs after the workflow is completed, failed, or already cleaned up. Pass force=true to override.");
    }

    const workers = this.teamStore
      .listWorkers(run.runId)
      .filter((worker) => !input.targetAlias || worker.alias === input.targetAlias);

    if (workers.length === 0) {
      throw new Error(input.targetAlias
        ? `No team worker matches alias ${input.targetAlias}.`
        : `No team workers are registered for run ${run.runId}.`);
    }

    const cleaned: Array<{ sessionID: string; alias: string; role: string; cleanedUpAt?: number; reason: string }> = [];
    const alreadyCleaned: Array<{ sessionID: string; alias: string; role: string; cleanedUpAt?: number }> = [];
    const failed: Array<{ sessionID: string; alias: string; role: string; error: string }> = [];

    for (const worker of workers) {
      const wasAlreadyCleaned = !!worker.cleanedUpAt;

      try {
        const sessionInfo = await this.input.client.session.get({
          path: { id: worker.sessionID },
          query: { directory: this.input.directory }
        });

        if (sessionInfo.error && sessionInfo.response?.status !== 404) {
          throw this.describeSessionClientError(sessionInfo.error);
        }

        let reason = "already_missing";
        if (sessionInfo.response?.status !== 404 && sessionInfo.data) {
          const deleted = await this.input.client.session.delete({
            path: { id: worker.sessionID },
            query: { directory: this.input.directory }
          });

          if (deleted.error && deleted.response?.status !== 404) {
            throw this.describeSessionClientError(deleted.error);
          }

          reason = deleted.response?.status === 404 ? "already_missing" : "deleted";
        }

        const roomThreads = this.threadStore
          .listThreadsForSession(worker.sessionID)
          .filter((entry) => entry.roomCode === run.roomCode);
        for (const entry of roomThreads) {
          this.threadStore.removeParticipant(entry.threadId, worker.sessionID);
        }
        this.roomStore.setMemberMembershipStatus(run.roomCode, worker.sessionID, "removed");
        this.sessionRegistry.remove(worker.sessionID);
        this.humanGuard.resumeSession(worker.sessionID);

        const updated = this.teamStore.markWorkerCleanedUp(worker.sessionID, run.roomCode) ?? worker;
        this.auditStore.append(run.runId, "team.worker.cleaned_up", {
          managerSessionID,
          sessionID: worker.sessionID,
          alias: worker.alias,
          role: worker.role,
          reason
        });
        if (wasAlreadyCleaned) {
          alreadyCleaned.push({
            sessionID: worker.sessionID,
            alias: worker.alias,
            role: worker.role,
            cleanedUpAt: updated.cleanedUpAt
          });
        } else {
          cleaned.push({
            sessionID: worker.sessionID,
            alias: worker.alias,
            role: worker.role,
            cleanedUpAt: updated.cleanedUpAt,
            reason
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown cleanup failure";
        this.auditStore.append(run.runId, "team.worker.cleanup_failed", {
          managerSessionID,
          sessionID: worker.sessionID,
          alias: worker.alias,
          role: worker.role,
          error: message
        });
        failed.push({
          sessionID: worker.sessionID,
          alias: worker.alias,
          role: worker.role,
          error: message
        });
      }
    }

    const refreshedRun = this.teamStore.getRun(run.runId) ?? run;

    this.auditStore.append(run.runId, "team.run.cleaned_up", {
      managerSessionID,
      roomCode: run.roomCode,
      targetAlias: input.targetAlias,
      force: Boolean(input.force),
      cleanedCount: cleaned.length,
      alreadyCleanedCount: alreadyCleaned.length,
      failedCount: failed.length
    });

    return {
      runId: run.runId,
      roomCode: run.roomCode,
      runStatus: refreshedRun.status,
      targetAlias: input.targetAlias,
      force: Boolean(input.force),
      cleaned,
      alreadyCleaned,
      failed,
      nextStep: failed.length > 0
        ? "Some worker sessions could not be cleaned up. Review failed entries and retry relay_team_cleanup if needed."
        : "Worker sessions were cleaned up. Relay history remains available through relay_team_status, transcripts, and audit events."
    };
  }

  getTeamStatus(sessionID: string, runId?: string, roomCode?: string): RelayTeamStatusView {
    return this.teamStatusService.getTeamStatus(sessionID, runId, roomCode);
  }

  getOperationsStatus(taskId?: string, recentDiagnosticLimit = 10): {
    activeTaskCount: number;
    roomCount: number;
    threadCount: number;
    knownSessionCount: number;
    sessionStatusCounts: Record<string, number>;
    pausedSessionCount: number;
    pausedSessions: Array<{ sessionID: string; reason: string }>;
    recentDiagnostics: AuditEventRecord[];
    task?: StoredRelayTask;
  } {
    const sessionSnapshots = this.sessionRegistry.entries();
    const sessionStatusCounts = sessionSnapshots.reduce<Record<string, number>>((acc, snapshot) => {
      const statusType = snapshot.status?.type ?? "unknown";
      acc[statusType] = (acc[statusType] ?? 0) + 1;
      return acc;
    }, {});

    return {
      activeTaskCount: this.taskStore.listActiveTasks().length,
      roomCount: this.roomStore.countRooms(),
      threadCount: this.threadStore.countThreads(),
      knownSessionCount: sessionSnapshots.length,
      sessionStatusCounts,
      pausedSessionCount: this.humanGuard.listPausedSessions().length,
      pausedSessions: this.humanGuard.listPausedSessions(),
      recentDiagnostics: this.getRecentDiagnostics(recentDiagnosticLimit),
      task: taskId ? this.taskStore.getTask(taskId) : undefined
    };
  }

  getRecentDiagnostics(limit = 10): AuditEventRecord[] {
    return this.auditStore.list(RelayRuntime.diagnosticsTaskId).slice(-limit);
  }

  pauseAutomation(sessionID: string, reason = "human takeover"): { sessionID: string; reason: string; paused: true } {
    this.humanGuard.pauseSession(sessionID, reason);
    this.recordDiagnostic("relay.session.paused", { sessionID, reason });
    return { sessionID, reason, paused: true };
  }

  resumeAutomation(sessionID: string): { sessionID: string; resumed: boolean; previousReason?: string } {
    const previousReason = this.humanGuard.reason(sessionID);
    const wasPaused = this.humanGuard.isPaused(sessionID);
    this.humanGuard.resumeSession(sessionID);
    this.recordDiagnostic("relay.session.resumed", { sessionID, previousReason, resumed: wasPaused });
    return { sessionID, resumed: wasPaused, previousReason };
  }

  buildTeamCompactionContext(sessionID: string, limit: number): string[] {
    return this.teamStatusService.buildTeamCompactionContext(sessionID, limit);
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

  private describeSessionClientError(error: unknown): Error {
    if (error instanceof Error) {
      return error;
    }
    if (typeof error === "string" && error.trim().length > 0) {
      return new Error(error);
    }
    if (error && typeof error === "object" && "message" in error && typeof error.message === "string") {
      return new Error(error.message);
    }
    return new Error("Session API request failed.");
  }

  async replayTask(taskId: string): Promise<StoredRelayTask | undefined> {
    const existing = this.taskStore.getTask(taskId);
    if (!existing) return undefined;
    if (!["failed", "canceled"].includes(existing.status)) {
      throw new Error(`Task ${taskId} is not replayable from status ${existing.status}.`);
    }

    const replayed = this.taskStore.transaction(() => {
      this.taskStore.updateStatus(taskId, "submitted", existing.latestMessage);
      const nextTask = this.taskStore.mergeMetadata(taskId, {
        relayDispatchSessionID: undefined,
        relayDispatchAcceptedAt: undefined
      });
      this.auditStore.append(taskId, "task.replayed", {});
      return nextTask;
    });
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

  listMessages(threadId: string, afterSeq = 0, limit = 100, sessionID?: string): RelayMessage[] {
    return this.relayOrchestrator.listMessages(threadId, afterSeq, limit, sessionID);
  }

  markThreadRead(threadId: string, sessionID: string, seq: number): unknown {
    return this.relayOrchestrator.markThreadRead(threadId, sessionID, seq);
  }

  exportTranscript(threadId: string, sessionID?: string): unknown {
    return this.relayOrchestrator.exportTranscript(threadId, sessionID);
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

    if (this.inFlightTaskDispatches.has(task.taskId) || isTaskDispatchAccepted(task, sessionID)) {
      return { sessionID };
    }

    this.inFlightTaskDispatches.add(task.taskId);

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
      this.taskStore.transaction(() => {
        this.observer.accept(task.taskId, sessionID);
        this.auditStore.append(task.taskId, "task.dispatched", { sessionID });
      });
      return { sessionID };
    } catch (error) {
      this.taskStore.transaction(() => {
        this.auditStore.append(task.taskId, "task.dispatch_failed", {
          sessionID,
          message: error instanceof Error ? error.message : "unknown error"
        });
        this.taskStore.updateStatus(task.taskId, "failed");
      });
      throw error;
    } finally {
      this.inFlightTaskDispatches.delete(task.taskId);
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
    const latestSeq = messages[messages.length - 1]?.seq ?? 0;
    const injectionKey = `${thread.threadId}:${sessionID}`;
    const managerPromptKey = `room:${thread.roomCode}:${sessionID}`;
    const lastInjectedSeq = this.lastInjectedThreadSeqByRecipient.get(injectionKey) ?? 0;
    if (latestSeq <= lastInjectedSeq) {
      this.recordDiagnostic("relay.send.inject_skipped", {
        injectorKind: "thread-notify",
        roomCode: thread.roomCode,
        threadId: thread.threadId,
        targetSessionID: sessionID,
        latestSeq,
        lastInjectedSeq,
        reason: "already_injected"
      });
      return;
    }

    const roomKind = this.roomStore.getRoom(thread.roomCode)?.kind;
    const senderRoles = Object.fromEntries(
      messages.map((message) => [message.senderSessionID, this.roomStore.getMember(thread.roomCode, message.senderSessionID)?.role as RelayRoomMemberRole | undefined])
    );
    const senderAliases = Object.fromEntries(
      messages.map((message) => [message.senderSessionID, this.roomStore.getMember(thread.roomCode, message.senderSessionID)?.alias])
    );
    const teamAccess = this.teamStore.getRunAccess(sessionID, thread.roomCode);
    const managerView = teamAccess?.role === "manager"
      ? {
          directory: this.input.directory,
          workerLinks: this.teamStore.listWorkers(teamAccess.run.runId).map((worker) => ({
            alias: worker.alias,
            role: worker.role,
            sessionID: worker.sessionID
          })),
          teamStatus: this.teamStatusService.getTeamStatus(sessionID, teamAccess.run.runId, thread.roomCode)
        }
      : undefined;

    const prompt = buildThreadRelayPrompt({
      roomCode: thread.roomCode,
      thread,
      roomKind,
      recipientSessionID: sessionID,
      messages,
      senderRoles,
      senderAliases,
      managerView
    });

    if (managerView) {
      const lastPrompt = this.lastManagerThreadPromptByRecipient.get(managerPromptKey);
      if (prompt === lastPrompt) {
        this.recordDiagnostic("relay.send.inject_skipped", {
          injectorKind: "thread-notify",
          roomCode: thread.roomCode,
          threadId: thread.threadId,
          targetSessionID: sessionID,
          latestSeq,
          lastInjectedSeq,
          reason: "unchanged_summary"
        });
        return;
      }
    }

    await this.injector.submitAsync(sessionID, prompt);
    this.lastInjectedThreadSeqByRecipient.set(injectionKey, latestSeq);
    if (managerView) {
      this.lastManagerThreadPromptByRecipient.set(managerPromptKey, prompt);
    }
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

  private recordRejectedTeamSignal(sourceSessionID: string, roomCode: string, rawMessage: string, rejectionReason: string): void {
    const access = this.teamStore.getRunAccess(sourceSessionID, roomCode);
    if (!access) {
      return;
    }

    this.auditStore.append(access.run.runId, "team.worker.signal_rejected", {
      sessionID: sourceSessionID,
      role: access.worker?.role ?? access.role,
      alias: access.worker?.alias,
      roomCode,
      rawMessage,
      rejectionReason
    });
  }
}
