import { randomUUID } from "node:crypto";

import { aggregateTeamRunStatus } from "../policy/team-status-policy.js";
import { validateWorkerSignalTransition } from "../policy/team-worker-transition-policy.js";
import { initializeRelaySchema } from "./schema.js";
import { openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export type RelayTeamRunStatus = "bootstrapping" | "waiting" | "ready" | "in_progress" | "blocked" | "completed" | "failed";
export type RelayTeamWorkerStatus = "created" | "bootstrapped" | "joined" | "ready" | "in_progress" | "blocked" | "completed" | "failed";

export type RelayTeamRun = {
  runId: string;
  managerSessionID: string;
  roomCode: string;
  task: string;
  status: RelayTeamRunStatus;
  createdAt: number;
  updatedAt: number;
};

export type RelayTeamWorker = {
  runId: string;
  sessionID: string;
  role: string;
  alias: string;
  title: string;
  status: RelayTeamWorkerStatus;
  lastNote?: string;
  workflowSource?: string;
  workflowPhase?: string;
  progress?: number;
  evidence?: unknown;
  createdAt: number;
  joinedAt?: number;
  readyAt?: number;
  cleanedUpAt?: number;
  updatedAt: number;
};

export type RelayTeamRunAccess = {
  run: RelayTeamRun;
  role: "manager" | "worker";
  worker?: RelayTeamWorker;
};

type RelayTeamRunRow = {
  run_id: string;
  manager_session_id: string;
  room_code: string;
  task: string;
  status: RelayTeamRunStatus;
  created_at: number;
  updated_at: number;
};

type RelayTeamWorkerRow = {
  run_id: string;
  session_id: string;
  role: string;
  alias: string;
  title: string;
  status: RelayTeamWorkerStatus;
  last_note: string | null;
  workflow_source: string | null;
  workflow_phase: string | null;
  progress: number | null;
  evidence_json: string | null;
  created_at: number;
  joined_at: number | null;
  ready_at: number | null;
  cleaned_up_at: number | null;
  updated_at: number;
};

type RelayTeamWorkerLookupRow = RelayTeamWorkerRow & {
  room_code: string;
  manager_session_id: string;
  run_status: RelayTeamRunStatus;
};

function createRunId(): string {
  return `teamrun_${randomUUID()}`;
}

function serializeEvidence(value: unknown): string | null {
  if (value === undefined) {
    return null;
  }

  return JSON.stringify(value);
}

function deserializeEvidence(value: string | null): unknown {
  if (!value) {
    return undefined;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export class TeamStore {
  private readonly database: SqliteDatabase;

  constructor(location = ":memory:") {
    this.database = openSqliteDatabase(location);
    initializeRelaySchema(this.database);
  }

  transaction<T>(callback: () => T): T {
    return this.database.transaction(callback);
  }

  createRun(input: { managerSessionID: string; roomCode: string; task: string }): RelayTeamRun {
    const now = Date.now();
    const runId = createRunId();
    this.database
      .prepare(`INSERT INTO relay_team_runs (run_id, manager_session_id, room_code, task, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(runId, input.managerSessionID, input.roomCode, input.task, "bootstrapping", now, now);

    return this.getRun(runId)!;
  }

  getRunForManager(sessionID: string, roomCode?: string, runId?: string): RelayTeamRun | undefined {
    if (runId) {
      const run = this.getRun(runId);
      if (!run) {
        return undefined;
      }
      if (roomCode && run.roomCode !== roomCode) {
        return undefined;
      }
      return run.managerSessionID === sessionID ? run : undefined;
    }

    const byManager = this.database
      .prepare(`
        SELECT * FROM relay_team_runs
        WHERE manager_session_id = ?
          AND (? IS NULL OR room_code = ?)
        ORDER BY updated_at DESC
        LIMIT 1
      `)
      .get(sessionID, roomCode ?? null, roomCode ?? null) as RelayTeamRunRow | undefined;

    return byManager ? this.hydrateRun(byManager) : undefined;
  }

  getRunForParticipant(sessionID: string, roomCode?: string, runId?: string): RelayTeamRun | undefined {
    return this.getRunForSession(sessionID, roomCode, runId);
  }

  getRunAccess(sessionID: string, roomCode?: string, runId?: string): RelayTeamRunAccess | undefined {
    const managerRun = this.getRunForManager(sessionID, roomCode, runId);
    if (managerRun) {
      return {
        run: managerRun,
        role: "manager"
      };
    }

    const workerRun = this.getRunForParticipant(sessionID, roomCode, runId);
    if (!workerRun) {
      return undefined;
    }

    const workerRow = this.findWorkerRow(sessionID, workerRun.roomCode);
    return {
      run: workerRun,
      role: "worker",
      worker: workerRow ? this.hydrateWorker(workerRow) : undefined
    };
  }

  addWorker(input: {
    runId: string;
    sessionID: string;
    role: string;
    alias: string;
    title: string;
    status?: RelayTeamWorkerStatus;
    lastNote?: string;
    workflowSource?: string;
    workflowPhase?: string;
    progress?: number;
    evidence?: unknown;
  }): RelayTeamWorker {
    return this.database.transaction(() => {
      const now = Date.now();
      this.database
        .prepare(`
          INSERT INTO relay_team_workers (run_id, session_id, role, alias, title, status, last_note, workflow_source, workflow_phase, progress, evidence_json, created_at, joined_at, ready_at, cleaned_up_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          input.runId,
          input.sessionID,
          input.role,
          input.alias,
          input.title,
          input.status ?? "created",
          input.lastNote ?? null,
          input.workflowSource ?? null,
          input.workflowPhase ?? null,
          input.progress ?? null,
          serializeEvidence(input.evidence),
          now,
          null,
          null,
          null,
          now
        );

      this.refreshRunStatus(input.runId);
      return this.requireWorker(input.runId, input.sessionID);
    });
  }

  getRun(runId: string): RelayTeamRun | undefined {
    const row = this.database.prepare(`SELECT * FROM relay_team_runs WHERE run_id = ?`).get(runId) as RelayTeamRunRow | undefined;
    return row ? this.hydrateRun(row) : undefined;
  }

  getRunByRoomCode(roomCode: string): RelayTeamRun | undefined {
    const row = this.database.prepare(`SELECT * FROM relay_team_runs WHERE room_code = ?`).get(roomCode) as RelayTeamRunRow | undefined;
    return row ? this.hydrateRun(row) : undefined;
  }

  getRunForSession(sessionID: string, roomCode?: string, runId?: string): RelayTeamRun | undefined {
    if (runId) {
      const run = this.getRun(runId);
      if (!run) {
        return undefined;
      }
      if (roomCode && run.roomCode !== roomCode) {
        return undefined;
      }
      if (run.managerSessionID === sessionID) {
        return run;
      }

      const worker = this.database
        .prepare(`
          SELECT w.run_id
          FROM relay_team_workers w
          JOIN relay_team_runs r ON r.run_id = w.run_id
          WHERE w.run_id = ? AND w.session_id = ?
            AND (? IS NULL OR r.room_code = ?)
          LIMIT 1
        `)
        .get(runId, sessionID, roomCode ?? null, roomCode ?? null) as { run_id: string } | undefined;

      return worker ? run : undefined;
    }

    const byManager = this.getRunForManager(sessionID, roomCode, runId);

    if (byManager) {
      return byManager;
    }

    const byWorker = this.findWorkerRow(sessionID, roomCode);
    return byWorker ? this.getRun(byWorker.run_id) : undefined;
  }

  listWorkers(runId: string): RelayTeamWorker[] {
    const rows = this.database
      .prepare(`SELECT * FROM relay_team_workers WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as RelayTeamWorkerRow[];
    return rows.map((row) => this.hydrateWorker(row));
  }

  markWorkerBootstrapped(sessionID: string): RelayTeamWorker | undefined {
    return this.updateWorkerBySession(sessionID, undefined, (worker) => ({
      status: ["created", "bootstrapped"].includes(worker.status) ? "bootstrapped" : worker.status,
      lastNote: "bootstrap prompt submitted"
    }));
  }

  markWorkerJoined(sessionID: string, roomCode: string, alias?: string): RelayTeamWorker | undefined {
    return this.updateWorkerBySession(sessionID, roomCode, (worker) => ({
      alias: alias?.trim() || worker.alias,
      status: ["created", "bootstrapped", "joined"].includes(worker.status) ? "joined" : worker.status,
      joinedAt: worker.joinedAt ?? Date.now(),
      lastNote: "joined relay room"
    }));
  }

  markWorkerSignal(sessionID: string, roomCode: string, input: {
    status: RelayTeamWorkerStatus;
    note?: string;
    ready: boolean;
    source?: string;
    phase?: string;
    progress?: number;
    evidence?: unknown;
  }): RelayTeamWorker | undefined {
    return this.updateWorkerBySession(sessionID, roomCode, (worker) => {
      const validation = validateWorkerSignalTransition(worker.status, input.status);
      if (!validation.accepted) {
        throw new Error(validation.rejectionReason);
      }

      return {
        status: input.status,
        readyAt: input.ready ? (worker.readyAt ?? Date.now()) : worker.readyAt,
        lastNote: input.note ?? worker.lastNote,
        workflowSource: input.source ?? worker.workflowSource,
        workflowPhase: input.phase ?? worker.workflowPhase,
        progress: input.progress ?? worker.progress,
        evidence: input.evidence ?? worker.evidence
      };
    });
  }

  markWorkerFailed(sessionID: string, errorMessage: string, roomCode?: string): RelayTeamWorker | undefined {
    return this.updateWorkerBySession(sessionID, roomCode, () => ({
      status: "failed",
      lastNote: errorMessage
    }));
  }

  markWorkerCleanedUp(sessionID: string, roomCode?: string): RelayTeamWorker | undefined {
    return this.updateWorkerBySession(sessionID, roomCode, () => ({
      cleanedUpAt: Date.now()
    }));
  }

  markRunFailed(runId: string): RelayTeamRun {
    this.database.prepare(`UPDATE relay_team_runs SET status = ?, updated_at = ? WHERE run_id = ?`).run("failed", Date.now(), runId);
    return this.getRun(runId)!;
  }

  close(): void {
    this.database.close();
  }

  private refreshRunStatus(runId: string): RelayTeamRun {
    const current = this.getRun(runId);
    if (!current) {
      throw new Error(`Team run not found: ${runId}`);
    }

    const nextStatus = aggregateTeamRunStatus(this.listWorkers(runId), current.status);
    this.database.prepare(`UPDATE relay_team_runs SET status = ?, updated_at = ? WHERE run_id = ?`).run(nextStatus, Date.now(), runId);
    return this.getRun(runId)!;
  }

  private requireWorker(runId: string, sessionID: string): RelayTeamWorker {
    const row = this.database
      .prepare(`SELECT * FROM relay_team_workers WHERE run_id = ? AND session_id = ?`)
      .get(runId, sessionID) as RelayTeamWorkerRow | undefined;

    if (!row) {
      throw new Error(`Team worker not found: ${sessionID} in ${runId}`);
    }

    return this.hydrateWorker(row);
  }

  private updateWorkerBySession(
    sessionID: string,
    roomCode: string | undefined,
    mutate: (worker: RelayTeamWorker) => Partial<Pick<RelayTeamWorker, "alias" | "status" | "lastNote" | "joinedAt" | "readyAt" | "workflowSource" | "workflowPhase" | "progress" | "evidence" | "cleanedUpAt">>
  ): RelayTeamWorker | undefined {
    const row = this.findWorkerRow(sessionID, roomCode);
    if (!row) {
      return undefined;
    }

    return this.database.transaction(() => {
      const worker = this.hydrateWorker(row);
      const patch = mutate(worker);
      const now = Date.now();
      this.database
        .prepare(`
          UPDATE relay_team_workers
          SET alias = ?, status = ?, last_note = ?, workflow_source = ?, workflow_phase = ?, progress = ?, evidence_json = ?, joined_at = ?, ready_at = ?, cleaned_up_at = ?, updated_at = ?
          WHERE run_id = ? AND session_id = ?
        `)
        .run(
          patch.alias ?? worker.alias,
          patch.status ?? worker.status,
          patch.lastNote ?? worker.lastNote ?? null,
          patch.workflowSource ?? worker.workflowSource ?? null,
          patch.workflowPhase ?? worker.workflowPhase ?? null,
          patch.progress ?? worker.progress ?? null,
          serializeEvidence(patch.evidence ?? worker.evidence),
          patch.joinedAt ?? worker.joinedAt ?? null,
          patch.readyAt ?? worker.readyAt ?? null,
          patch.cleanedUpAt ?? worker.cleanedUpAt ?? null,
          now,
          worker.runId,
          worker.sessionID
        );

      this.refreshRunStatus(worker.runId);
      return this.requireWorker(worker.runId, worker.sessionID);
    });
  }

  private findWorkerRow(sessionID: string, roomCode?: string): RelayTeamWorkerLookupRow | undefined {
    return this.database
      .prepare(`
        SELECT w.*, r.room_code, r.manager_session_id, r.status as run_status
        FROM relay_team_workers w
        JOIN relay_team_runs r ON r.run_id = w.run_id
        WHERE w.session_id = ?
          AND (? IS NULL OR r.room_code = ?)
        ORDER BY w.updated_at DESC
        LIMIT 1
      `)
      .get(sessionID, roomCode ?? null, roomCode ?? null) as RelayTeamWorkerLookupRow | undefined;
  }

  private hydrateRun(row: RelayTeamRunRow): RelayTeamRun {
    return {
      runId: row.run_id,
      managerSessionID: row.manager_session_id,
      roomCode: row.room_code,
      task: row.task,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private hydrateWorker(row: RelayTeamWorkerRow): RelayTeamWorker {
    return {
      runId: row.run_id,
      sessionID: row.session_id,
      role: row.role,
      alias: row.alias,
      title: row.title,
      status: row.status,
      lastNote: row.last_note ?? undefined,
      workflowSource: row.workflow_source ?? undefined,
      workflowPhase: row.workflow_phase ?? undefined,
      progress: row.progress ?? undefined,
      evidence: deserializeEvidence(row.evidence_json),
      createdAt: row.created_at,
      joinedAt: row.joined_at ?? undefined,
      readyAt: row.ready_at ?? undefined,
      cleanedUpAt: row.cleaned_up_at ?? undefined,
      updatedAt: row.updated_at
    };
  }
}
