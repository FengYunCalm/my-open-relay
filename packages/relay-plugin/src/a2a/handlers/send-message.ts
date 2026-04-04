import { createOpaqueId, type JsonRpcRequest, type TaskStatus } from "@opencode-peer-session-relay/a2a-protocol";

import type { AuditStore } from "../../internal/store/audit-store.js";
import type { SessionLinkStore } from "../../internal/store/session-link-store.js";
import type { StoredRelayTask, TaskStore } from "../../internal/store/task-store.js";
import type { HumanGuard } from "../../runtime/human-guard.js";
import type { LoopGuard } from "../../runtime/loop-guard.js";
import { mapTaskStatusEvent, type TaskEventHub } from "../mapper/outbound-events.js";
import { mapSendMessageRequest, type InboundRelayRequest } from "../mapper/inbound-request.js";

export type RelayDispatchResult = {
  sessionID?: string;
};

export type RelayExecutor = {
  dispatch(input: InboundRelayRequest & { taskId: string }): Promise<RelayDispatchResult>;
};

export type SendMessageDependencies = {
  taskStore: TaskStore;
  auditStore: AuditStore;
  sessionLinkStore: SessionLinkStore;
  executor: RelayExecutor;
  humanGuard?: HumanGuard;
  loopGuard?: LoopGuard;
  eventHub?: TaskEventHub;
  routeGuard?: (request: InboundRelayRequest) => void | Promise<void>;
};

function buildDedupeKey(request: InboundRelayRequest): string {
  return `${request.sourceSessionID ?? "unknown-source"}->${request.sessionID ?? "global"}:${request.message.messageId}`;
}

async function createAndDispatchTask(
  dependencies: SendMessageDependencies,
  request: InboundRelayRequest,
  taskId: string
): Promise<StoredRelayTask> {
  await dependencies.routeGuard?.(request);

  const dedupeKey = buildDedupeKey(request);
  const existing = dependencies.taskStore.getTaskByDedupeKey(dedupeKey);

  if (existing) {
    return existing;
  }

  const duplicate = dependencies.loopGuard?.remember(dedupeKey, taskId);
  if (duplicate?.duplicate && duplicate.existingTaskId) {
    return dependencies.taskStore.getTask(duplicate.existingTaskId) ?? dependencies.taskStore.getTaskByDedupeKey(dedupeKey)!;
  }

  const paused = dependencies.humanGuard?.isPaused(request.sessionID) ?? false;
  const status: TaskStatus = paused ? "input-required" : "submitted";

  const task = dependencies.taskStore.createTask({
    taskId,
    contextId: request.contextId,
    requestMessage: request.message,
    status,
    metadata: {
      ...request.metadata,
      requestId: request.requestId,
      sourceSessionID: request.sourceSessionID,
      pauseReason: paused ? dependencies.humanGuard?.reason(request.sessionID) : undefined,
      sessionID: request.sessionID
    },
    dedupeKey
  });

  dependencies.auditStore.append(taskId, "task.created", {
    requestId: request.requestId,
    sourceSessionID: request.sourceSessionID,
    paused,
    sessionID: request.sessionID
  });
  dependencies.eventHub?.emit(taskId, mapTaskStatusEvent(task));

  if (paused) {
    return task;
  }

  const dispatchResult = await dependencies.executor.dispatch({ ...request, taskId });
  if (dispatchResult.sessionID) {
    dependencies.sessionLinkStore.link(taskId, dispatchResult.sessionID);
    return dependencies.taskStore.mergeMetadata(taskId, { sessionID: dispatchResult.sessionID });
  }

  return task;
}

export function createSendMessageHandler(dependencies: SendMessageDependencies) {
  return async (request: JsonRpcRequest, explicitTaskId?: string): Promise<StoredRelayTask> => {
    const mapped = mapSendMessageRequest(request);
    const taskId = explicitTaskId ?? createOpaqueId("task");
    return createAndDispatchTask(dependencies, mapped, taskId);
  };
}
