import type { SessionStatus } from "@opencode-ai/sdk";

import type { AuditEventRecord, AuditStore } from "../internal/store/audit-store.js";
import type { RelayTeamRun, RelayTeamRunStatus, RelayTeamWorker, TeamStore } from "../internal/store/team-store.js";
import type { HumanGuard } from "./human-guard.js";
import type { SessionRegistry } from "./session-registry.js";

export type RelayTeamWorkerHealth = "active" | "stale" | "paused" | "unknown" | "settled" | "cleaned_up";

export type RelayTeamWorkerView = RelayTeamWorker & {
  health: RelayTeamWorkerHealth;
  stale: boolean;
  sessionStatus?: SessionStatus["type"];
  sessionUpdatedAt?: number;
};

export type RelayTeamInterventionAction = "retry" | "reassign" | "unblock" | "nudge";

export type RelayTeamPolicyDecision = {
  mode: "observe" | "manual_intervention" | "escalate";
  action?: RelayTeamInterventionAction;
  targetAlias?: string;
  severity: "medium" | "high";
  reason: string;
  requiresExplicitApply: boolean;
  sourceKind: string;
};

export type RelayTeamStatusView = {
  runId: string;
  roomCode: string;
  task: string;
  status: RelayTeamRunStatus;
  managerSessionID: string;
  currentSessionRole: string;
  workers: RelayTeamWorkerView[];
  summary: {
    counts: Record<string, number>;
    healthCounts: Record<string, number>;
  };
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

export class TeamStatusService {
  constructor(
    private readonly dependencies: {
      teamStore: TeamStore;
      auditStore: AuditStore;
      sessionRegistry: SessionRegistry;
      humanGuard: HumanGuard;
      teamWorkerStaleAfterMs: number;
    }
  ) {}

  getTeamStatus(sessionID: string, runId?: string, roomCode?: string): RelayTeamStatusView {
    const access = this.dependencies.teamStore.getRunAccess(sessionID, roomCode, runId);
    if (!access) {
      throw new Error(`No relay workflow team is bound to session ${sessionID}.`);
    }

    const run = access.run;
    const workers = this.dependencies.teamStore.listWorkers(run.runId).map((worker) => this.decorateTeamWorker(worker));
    const currentWorker = workers.find((worker) => worker.sessionID === sessionID);
    const counts = workers.reduce<Record<string, number>>((acc, worker) => {
      acc[worker.status] = (acc[worker.status] ?? 0) + 1;
      return acc;
    }, {});
    const healthCounts = workers.reduce<Record<string, number>>((acc, worker) => {
      acc[worker.health] = (acc[worker.health] ?? 0) + 1;
      return acc;
    }, {});
    const allWorkersCleaned = workers.length > 0 && workers.every((worker) => !!worker.cleanedUpAt);

    const allEvents = this.dependencies.auditStore.list(run.runId);
    const recentEvents = allEvents.slice(-12);
    const attentionItems = allWorkersCleaned ? [] : this.buildAttentionItems(workers, allEvents);
    const interventionOutcomes = allWorkersCleaned ? [] : this.buildInterventionOutcomes(workers, allEvents);
    const policyDecisions = allWorkersCleaned ? [] : this.buildPolicyDecisions(workers, allEvents);
    const recommendedActions = allWorkersCleaned ? [] : this.buildRecommendedActions(workers, recentEvents);

    return {
      runId: run.runId,
      roomCode: run.roomCode,
      task: run.task,
      status: run.status,
      managerSessionID: run.managerSessionID,
      currentSessionRole: access.role === "manager" ? "manager" : (access.worker?.role ?? currentWorker?.role ?? "worker"),
      workers,
      summary: { counts, healthCounts },
      recentEvents,
      attentionItems,
      interventionOutcomes,
      policyDecisions,
      recommendedActions,
      nextStep: this.buildTeamNextStep(run, workers)
    };
  }

  buildTeamCompactionContext(sessionID: string, limit: number): string[] {
    const access = this.dependencies.teamStore.getRunAccess(sessionID);
    if (!access) {
      return [];
    }

    const run = access.run;
    const workers = this.dependencies.teamStore.listWorkers(run.runId).slice(0, limit);
    const currentWorker = workers.find((worker) => worker.sessionID === sessionID);
    return [
      "## Team Workflow",
      `Run: ${run.runId}`,
      `Role: ${access.role === "manager" ? "manager" : (access.worker?.role ?? currentWorker?.role ?? "worker")}`,
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
          decorated.cleanedUpAt ? "cleanup=done" : undefined,
          decorated.lastNote ? `note=${decorated.lastNote}` : undefined
        ].filter(Boolean);
        return `- ${parts.join(" ")}`;
      }).join("; ")}`
    ];
  }

  private decorateTeamWorker(worker: RelayTeamWorker): RelayTeamWorkerView {
    const sessionSnapshot = this.dependencies.sessionRegistry.get(worker.sessionID);
    const now = Date.now();
    const latestActivityAt = Math.max(worker.updatedAt, sessionSnapshot?.updatedAt ?? 0);
    const stale = !worker.cleanedUpAt
      && !["completed", "failed"].includes(worker.status)
      && now - latestActivityAt > this.dependencies.teamWorkerStaleAfterMs;

    let health: RelayTeamWorkerHealth;
    if (worker.cleanedUpAt) {
      health = "cleaned_up";
    } else if (["completed", "failed"].includes(worker.status)) {
      health = "settled";
    } else if (this.dependencies.humanGuard.isPaused(worker.sessionID)) {
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
      sessionStatus: worker.cleanedUpAt ? undefined : sessionSnapshot?.status?.type,
      sessionUpdatedAt: worker.cleanedUpAt ? undefined : sessionSnapshot?.updatedAt
    };
  }

  private buildTeamNextStep(run: RelayTeamRun, workers: RelayTeamWorkerView[]): string {
    if (run.status === "cleaned_up" || (workers.length > 0 && workers.every((worker) => !!worker.cleanedUpAt))) {
      return "Worker sessions were cleaned up. Relay room, thread, and audit history remain available for review.";
    }
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
    return this.dependencies.auditStore.list(runId).slice(-limit);
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
      if (worker.cleanedUpAt) {
        continue;
      }
      if (worker.health === "stale") {
        pushAction("nudge", worker.alias, undefined, `${worker.alias} looks stale and may need a wake-up check.`);
      }
      if (worker.status === "blocked") {
        pushAction("unblock", worker.alias, undefined, worker.lastNote ? `${worker.alias} is blocked: ${worker.lastNote}` : `${worker.alias} is blocked and needs manager input.`);
      }
    }

    const unresolvedRejectedSignals = this.resolveUnresolvedRejectedSignals(recentEvents);

    for (const [alias, rejected] of unresolvedRejectedSignals.entries()) {
      pushAction("retry", alias, undefined, `${alias} should resend a valid TEAM signal: ${rejected.latestReason}`);
    }

    for (const event of recentEvents) {
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

  private resolveUnresolvedRejectedSignals(events: AuditEventRecord[]): Map<string, { count: number; latestReason: string }> {
    const unresolved = new Map<string, { count: number; latestReason: string }>();

    for (const event of events) {
      const alias = typeof event.payload.alias === "string" ? event.payload.alias : undefined;
      if (!alias) {
        continue;
      }

      if (["team.worker.ready", "team.worker.in_progress", "team.worker.completed", "team.worker.blocked"].includes(event.eventType)) {
        unresolved.delete(alias);
        continue;
      }

      if (event.eventType === "team.worker.signal_rejected") {
        const existing = unresolved.get(alias);
        unresolved.set(alias, {
          count: (existing?.count ?? 0) + 1,
          latestReason: typeof event.payload.rejectionReason === "string"
            ? event.payload.rejectionReason
            : existing?.latestReason ?? "invalid workflow signal"
        });
      }
    }

    return unresolved;
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
      if (worker.cleanedUpAt) {
        continue;
      }
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

    const unresolvedRejectedSignals = this.resolveUnresolvedRejectedSignals(allEvents);
    const interventionCounts = new Map<string, number>();
    const latestInterventionAction = new Map<string, RelayTeamInterventionAction>();

    for (const event of allEvents) {
      const workerAlias = typeof event.payload.alias === "string" ? event.payload.alias : undefined;

      if (event.eventType === "team.manager.intervention") {
        const targetAlias = typeof event.payload.targetAlias === "string" ? event.payload.targetAlias : undefined;
        const action = typeof event.payload.action === "string" ? event.payload.action as RelayTeamInterventionAction : undefined;
        if (targetAlias && action) {
          interventionCounts.set(targetAlias, (interventionCounts.get(targetAlias) ?? 0) + 1);
          latestInterventionAction.set(targetAlias, action);
        }
      }
    }

    for (const [workerAlias, rejected] of unresolvedRejectedSignals.entries()) {
      pushItem({
        kind: "rejected_signal",
        severity: rejected.count >= 2 ? "high" : "medium",
        targetAlias: workerAlias,
        count: rejected.count,
        reason: `${workerAlias} still has unresolved rejected TEAM signals: ${rejected.latestReason}`,
        suggestedAction: "retry"
      });
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

      const rejectedCount = unresolvedRejectedSignals.get(worker.alias)?.count ?? 0;
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
        if (worker?.cleanedUpAt) {
          status = "resolved";
          reason = `${targetAlias} session was cleaned up`;
        } else if (worker?.health === "stale" || worker?.status === "blocked") {
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
}
