import { randomUUID } from "node:crypto";

import { initializeRelaySchema } from "./schema.js";
import { isRetryableSqliteError, openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export type RelayThreadKind = "direct" | "group";

export type RelayThread = {
  threadId: string;
  roomCode: string;
  kind: RelayThreadKind;
  title?: string;
  directKey?: string;
  createdBySessionID: string;
  createdAt: number;
  updatedAt: number;
};

export type RelayThreadParticipant = {
  threadId: string;
  sessionID: string;
  lastReadSeq: number;
  lastNotifiedSeq: number;
  joinedAt: number;
  updatedAt: number;
};

type RelayThreadRow = {
  thread_id: string;
  room_code: string;
  kind: RelayThreadKind;
  title: string | null;
  direct_key: string | null;
  created_by_session_id: string;
  created_at: number;
  updated_at: number;
};

type RelayThreadParticipantRow = {
  thread_id: string;
  session_id: string;
  last_read_seq: number;
  last_notified_seq: number;
  joined_at: number;
  updated_at: number;
};

function createThreadId(): string {
  return `thread_${randomUUID()}`;
}

function createDirectKey(roomCode: string, sessionIDs: string[]): string {
  return `${roomCode}:${[...new Set(sessionIDs)].sort().join(":")}`;
}

function shouldRetryThreadMutation(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return isRetryableSqliteError(error) || message.includes("unique") || message.includes("constraint");
}

export class ThreadStore {
  private readonly database: SqliteDatabase;

  constructor(location = ":memory:") {
    this.database = openSqliteDatabase(location);
    initializeRelaySchema(this.database);
  }

  transaction<T>(callback: () => T): T {
    return this.database.transaction(callback);
  }

  ensureDirectThread(roomCode: string, participantSessionIDs: string[], createdBySessionID: string): RelayThread {
    const directKey = createDirectKey(roomCode, participantSessionIDs);
    const existing = this.getThreadByDirectKey(directKey);
    if (existing) {
      return existing;
    }

    try {
      return this.createThread({
        roomCode,
        kind: "direct",
        directKey,
        createdBySessionID,
        participantSessionIDs
      });
    } catch (error) {
      if (shouldRetryThreadMutation(error)) {
        const concurrent = this.getThreadByDirectKey(directKey);
        if (concurrent) {
          return concurrent;
        }
      }
      throw error;
    }
  }

  ensureGroupThread(roomCode: string, participantSessionIDs: string[], createdBySessionID: string, title = "room-main"): RelayThread {
    const existing = this.getThreadByKindAndTitle(roomCode, "group", title);
    if (existing) {
      this.addParticipants(existing.threadId, participantSessionIDs);
      return this.getThread(existing.threadId)!;
    }

    return this.createThread({
      roomCode,
      kind: "group",
      title,
      createdBySessionID,
      participantSessionIDs
    });
  }

  createGroupThread(roomCode: string, participantSessionIDs: string[], createdBySessionID: string, title?: string): RelayThread {
    return this.createThread({
      roomCode,
      kind: "group",
      title,
      createdBySessionID,
      participantSessionIDs
    });
  }

  getThread(threadId: string): RelayThread | undefined {
    const row = this.database.prepare(`SELECT * FROM relay_threads WHERE thread_id = ?`).get(threadId) as RelayThreadRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  getThreadByDirectKey(directKey: string): RelayThread | undefined {
    const row = this.database.prepare(`SELECT * FROM relay_threads WHERE direct_key = ?`).get(directKey) as RelayThreadRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  getThreadByKindAndTitle(roomCode: string, kind: RelayThreadKind, title: string): RelayThread | undefined {
    const row = this.database.prepare(`SELECT * FROM relay_threads WHERE room_code = ? AND kind = ? AND title = ? LIMIT 1`).get(roomCode, kind, title) as RelayThreadRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  listThreadsForRoom(roomCode: string): RelayThread[] {
    const rows = this.database.prepare(`SELECT * FROM relay_threads WHERE room_code = ? ORDER BY updated_at ASC`).all(roomCode) as RelayThreadRow[];
    return rows.map((row) => this.hydrate(row));
  }

  countThreads(): number {
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM relay_threads`)
      .get() as { count?: number } | undefined;

    return row?.count ?? 0;
  }

  listThreadsForSession(sessionID: string): Array<RelayThread & { participant: RelayThreadParticipant }> {
    const rows = this.database.prepare(`
        SELECT t.*, p.thread_id as participant_thread_id, p.session_id, p.last_read_seq, p.last_notified_seq, p.joined_at, p.updated_at as participant_updated_at
        FROM relay_threads t
        JOIN relay_thread_participants p ON p.thread_id = t.thread_id
        WHERE p.session_id = ?
        ORDER BY t.updated_at ASC
      `).all(sessionID) as Array<RelayThreadRow & {
      participant_thread_id: string;
      session_id: string;
      last_read_seq: number;
      last_notified_seq: number;
      joined_at: number;
      participant_updated_at: number;
    }>;

    return rows.map((row) => ({
      ...this.hydrate(row),
      participant: {
        threadId: row.participant_thread_id,
        sessionID: row.session_id,
        lastReadSeq: row.last_read_seq,
        lastNotifiedSeq: row.last_notified_seq,
        joinedAt: row.joined_at,
        updatedAt: row.participant_updated_at
      }
    }));
  }

  listParticipants(threadId: string): RelayThreadParticipant[] {
    const rows = this.database.prepare(`SELECT * FROM relay_thread_participants WHERE thread_id = ? ORDER BY joined_at ASC`).all(threadId) as RelayThreadParticipantRow[];
    return rows.map((row) => this.hydrateParticipant(row));
  }

  getParticipant(threadId: string, sessionID: string): RelayThreadParticipant | undefined {
    const row = this.database.prepare(`SELECT * FROM relay_thread_participants WHERE thread_id = ? AND session_id = ?`).get(threadId, sessionID) as RelayThreadParticipantRow | undefined;
    return row ? this.hydrateParticipant(row) : undefined;
  }

  addParticipants(threadId: string, sessionIDs: string[]): void {
    this.database.transaction(() => {
      const now = Date.now();
      const uniqueSessionIDs = [...new Set(sessionIDs)];
      for (const sessionID of uniqueSessionIDs) {
        this.database.prepare(`
            INSERT INTO relay_thread_participants (thread_id, session_id, last_read_seq, last_notified_seq, joined_at, updated_at)
            VALUES (?, ?, 0, 0, ?, ?)
            ON CONFLICT(thread_id, session_id) DO NOTHING
          `).run(threadId, sessionID, now, now);
      }
      this.touchThread(threadId);
    });
  }

  markRead(threadId: string, sessionID: string, seq: number): RelayThreadParticipant {
    const now = Date.now();
    this.database.prepare(`UPDATE relay_thread_participants SET last_read_seq = MAX(last_read_seq, ?), updated_at = ? WHERE thread_id = ? AND session_id = ?`).run(seq, now, threadId, sessionID);
    return this.requireParticipant(threadId, sessionID);
  }

  markNotified(threadId: string, sessionID: string, seq: number): RelayThreadParticipant {
    const now = Date.now();
    this.database.prepare(`UPDATE relay_thread_participants SET last_notified_seq = MAX(last_notified_seq, ?), updated_at = ? WHERE thread_id = ? AND session_id = ?`).run(seq, now, threadId, sessionID);
    return this.requireParticipant(threadId, sessionID);
  }

  touchThread(threadId: string): void {
    this.database.prepare(`UPDATE relay_threads SET updated_at = ? WHERE thread_id = ?`).run(Date.now(), threadId);
  }

  close(): void {
    this.database.close();
  }

  private createThread(input: {
    roomCode: string;
    kind: RelayThreadKind;
    title?: string;
    directKey?: string;
    createdBySessionID: string;
    participantSessionIDs: string[];
  }): RelayThread {
    return this.database.transaction(() => {
      const now = Date.now();
      const threadId = createThreadId();
      const uniqueParticipants = [...new Set(input.participantSessionIDs)];

      this.database.prepare(`INSERT INTO relay_threads (thread_id, room_code, kind, title, direct_key, created_by_session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(threadId, input.roomCode, input.kind, input.title ?? null, input.directKey ?? null, input.createdBySessionID, now, now);

      for (const sessionID of uniqueParticipants) {
        this.database.prepare(`INSERT INTO relay_thread_participants (thread_id, session_id, last_read_seq, last_notified_seq, joined_at, updated_at) VALUES (?, ?, 0, 0, ?, ?)`).run(threadId, sessionID, now, now);
      }

      return this.getThread(threadId)!;
    });
  }

  private requireParticipant(threadId: string, sessionID: string): RelayThreadParticipant {
    const participant = this.getParticipant(threadId, sessionID);
    if (!participant) {
      throw new Error(`Participant ${sessionID} is not in thread ${threadId}.`);
    }
    return participant;
  }

  private hydrate(row: RelayThreadRow): RelayThread {
    return {
      threadId: row.thread_id,
      roomCode: row.room_code,
      kind: row.kind,
      title: row.title ?? undefined,
      directKey: row.direct_key ?? undefined,
      createdBySessionID: row.created_by_session_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    };
  }

  private hydrateParticipant(row: RelayThreadParticipantRow): RelayThreadParticipant {
    return {
      threadId: row.thread_id,
      sessionID: row.session_id,
      lastReadSeq: row.last_read_seq,
      lastNotifiedSeq: row.last_notified_seq,
      joinedAt: row.joined_at,
      updatedAt: row.updated_at
    };
  }
}
