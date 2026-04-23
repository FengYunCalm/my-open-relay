import { initializeRelaySchema } from "./schema.js";
import { isRetryableSqliteError, openSqliteDatabase, type SqliteDatabase } from "./sqlite.js";

export type RelayRoomKind = "private" | "group";
export type RelayRoomStatus = "open" | "active";
export type RelayRoomMemberRole = "owner" | "member" | "observer";
export type RelayRoomMembershipStatus = "active" | "left" | "removed";

export type RelayRoom = {
  roomCode: string;
  kind: RelayRoomKind;
  createdBySessionID: string;
  joinedSessionID?: string;
  status: RelayRoomStatus;
  createdAt: number;
  joinedAt?: number;
  updatedAt: number;
};

export type RelayRoomMember = {
  roomCode: string;
  sessionID: string;
  alias?: string;
  role: RelayRoomMemberRole;
  membershipStatus: RelayRoomMembershipStatus;
  joinedAt: number;
  updatedAt: number;
};

type RelayRoomRow = {
  room_code: string;
  room_kind: RelayRoomKind;
  created_by_session_id: string;
  joined_session_id: string | null;
  status: RelayRoomStatus;
  created_at: number;
  joined_at: number | null;
  updated_at: number;
};

type RelayRoomMemberRow = {
  room_code: string;
  session_id: string;
  alias: string | null;
  role: RelayRoomMemberRole;
  membership_status: RelayRoomMembershipStatus;
  joined_at: number;
  updated_at: number;
};

function createRoomCode(): string {
  return `${Math.floor(Math.random() * 1_000_000)}`.padStart(6, "0");
}

function normalizeAlias(alias: string): string {
  return alias.trim().toLocaleLowerCase();
}

function shouldRetryRoomMutation(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return isRetryableSqliteError(error) || message.includes("unique") || message.includes("constraint");
}

export class RoomStore {
  private readonly database: SqliteDatabase;

  constructor(location = ":memory:") {
    this.database = openSqliteDatabase(location);
    initializeRelaySchema(this.database);
  }

  transaction<T>(callback: () => T): T {
    return this.database.transaction(callback);
  }

  createRoom(sessionID: string, kind: RelayRoomKind = "private"): RelayRoom {
    const existing = this.getRoomBySession(sessionID, kind);
    if (existing) {
      return existing;
    }

    for (let attempt = 0; attempt < 20; attempt += 1) {
      const roomCode = createRoomCode();
      const now = Date.now();

      try {
        return this.database.transaction(() => {
          this.database
            .prepare(`INSERT INTO relay_rooms (room_code, room_kind, created_by_session_id, joined_session_id, status, created_at, joined_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
            .run(roomCode, kind, sessionID, null, "open", now, null, now);
          this.upsertMember(roomCode, sessionID, sessionID, "owner", now);
          return this.getRoom(roomCode)!;
        });
      } catch (error) {
        if (attempt < 19 && shouldRetryRoomMutation(error)) {
          continue;
        }
        throw error;
      }
    }

    throw new Error("Failed to allocate a unique relay room code.");
  }

  joinRoom(roomCode: string, sessionID: string, alias?: string): RelayRoom {
    return this.database.transaction(() => {
      const room = this.getRoom(roomCode);
      if (!room) {
        throw new Error(`Room ${roomCode} does not exist.`);
      }

      const now = Date.now();
      const existingMember = this.getMember(roomCode, sessionID);
      if (existingMember?.membershipStatus === "active") {
        return room;
      }

      if (room.kind === "private") {
        this.database
          .prepare(`
            UPDATE relay_room_members
            SET membership_status = 'removed', updated_at = ?
            WHERE room_code = ? AND session_id != ? AND role != 'owner' AND membership_status = 'active'
          `)
          .run(now, roomCode, sessionID);
      }

      const memberAlias = room.kind === "group" ? alias?.trim() : undefined;
      if (room.kind === "group" && !memberAlias) {
        throw new Error("Joining a group room requires an alias.");
      }

      this.ensureAliasAvailable(roomCode, memberAlias, sessionID);
      this.upsertMember(roomCode, sessionID, memberAlias ?? sessionID, "member", now);

      const activeMembers = this.listMembers(roomCode);
      const firstJoinedPeer = activeMembers
        .filter((member) => member.role !== "owner")
        .sort((left, right) => left.joinedAt - right.joinedAt)[0];

      this.database
        .prepare(`UPDATE relay_rooms SET joined_session_id = ?, status = ?, joined_at = COALESCE(joined_at, ?), updated_at = ? WHERE room_code = ?`)
        .run(firstJoinedPeer?.sessionID ?? null, activeMembers.length > 1 ? "active" : "open", now, now, roomCode);

      return this.getRoom(roomCode)!;
    });
  }

  setMemberRole(roomCode: string, sessionID: string, role: RelayRoomMemberRole): RelayRoomMember {
    const member = this.getMember(roomCode, sessionID);
    if (!member || member.membershipStatus !== "active") {
      throw new Error(`Session ${sessionID} is not an active member of room ${roomCode}.`);
    }

    this.database
      .prepare(`UPDATE relay_room_members SET role = ?, updated_at = ? WHERE room_code = ? AND session_id = ?`)
      .run(role, Date.now(), roomCode, sessionID);

    return this.getMember(roomCode, sessionID)!;
  }

  getOwner(roomCode: string): RelayRoomMember {
    const row = this.database
      .prepare(`SELECT * FROM relay_room_members WHERE room_code = ? AND role = 'owner' AND membership_status = 'active' LIMIT 1`)
      .get(roomCode) as RelayRoomMemberRow | undefined;

    if (!row) {
      throw new Error(`Room ${roomCode} does not have an active owner.`);
    }

    return this.hydrateMember(row);
  }

  getRoom(roomCode: string): RelayRoom | undefined {
    const row = this.database
      .prepare(`SELECT * FROM relay_rooms WHERE room_code = ?`)
      .get(roomCode) as RelayRoomRow | undefined;

    return row ? this.hydrate(row) : undefined;
  }

  getRoomBySession(sessionID: string, kind?: RelayRoomKind): RelayRoom | undefined {
    const rooms = this.listRoomsBySession(sessionID).filter((room) => !kind || room.kind === kind);
    return rooms[0];
  }

  listRoomsBySession(sessionID: string): RelayRoom[] {
    const rows = this.database
      .prepare(`
        SELECT r.*
        FROM relay_rooms r
        JOIN relay_room_members m ON m.room_code = r.room_code
        WHERE m.session_id = ? AND m.membership_status = 'active'
        ORDER BY r.updated_at DESC
      `)
      .all(sessionID) as RelayRoomRow[];

    return rows.map((row) => this.hydrate(row));
  }

  countRooms(): number {
    const row = this.database
      .prepare(`SELECT COUNT(*) AS count FROM relay_rooms`)
      .get() as { count?: number } | undefined;

    return row?.count ?? 0;
  }

  listMembers(roomCode: string): RelayRoomMember[] {
    const rows = this.database
      .prepare(`
        SELECT *
        FROM relay_room_members
        WHERE room_code = ? AND membership_status = 'active'
        ORDER BY CASE WHEN role = 'owner' THEN 0 ELSE 1 END ASC, joined_at ASC, session_id ASC
      `)
      .all(roomCode) as RelayRoomMemberRow[];

    return rows.map((row) => this.hydrateMember(row));
  }

  listWritableMembers(roomCode: string): RelayRoomMember[] {
    return this.listMembers(roomCode).filter((member) => member.role !== "observer");
  }

  getMember(roomCode: string, sessionID: string): RelayRoomMember | undefined {
    const row = this.database
      .prepare(`SELECT * FROM relay_room_members WHERE room_code = ? AND session_id = ?`)
      .get(roomCode, sessionID) as RelayRoomMemberRow | undefined;

    return row ? this.hydrateMember(row) : undefined;
  }

  getMemberByAlias(roomCode: string, alias: string): RelayRoomMember | undefined {
    const normalizedAlias = normalizeAlias(alias);
    const row = this.database
      .prepare(`SELECT * FROM relay_room_members WHERE room_code = ? AND lower(alias) = ? AND membership_status = 'active' LIMIT 1`)
      .get(roomCode, normalizedAlias) as RelayRoomMemberRow | undefined;

    return row ? this.hydrateMember(row) : undefined;
  }

  getPeerSessionID(sessionID: string): string | undefined {
    const room = this.getRoomBySession(sessionID);
    if (!room || room.status !== "active") {
      return undefined;
    }

    const otherMembers = this.listWritableMembers(room.roomCode).filter((member) => member.sessionID !== sessionID);
    if (otherMembers.length !== 1) {
      return undefined;
    }

    return otherMembers[0]?.sessionID;
  }

  getMemberSessionIDs(roomCode: string): string[] {
    return this.listMembers(roomCode).map((member) => member.sessionID);
  }

  listActiveSessionIDs(): string[] {
    const rows = this.database
      .prepare(`SELECT DISTINCT session_id FROM relay_room_members WHERE membership_status = 'active' ORDER BY session_id ASC`)
      .all() as Array<{ session_id: string }>;

    return rows.map((row) => row.session_id);
  }

  areSessionsPaired(sourceSessionID: string, targetSessionID: string): boolean {
    const sourceRoom = this.getRoomBySession(sourceSessionID);
    if (!sourceRoom || sourceRoom.status !== "active") {
      return false;
    }

    return this.listMembers(sourceRoom.roomCode).some((member) => member.sessionID === targetSessionID);
  }

  close(): void {
    this.database.close();
  }

  private ensureAliasAvailable(roomCode: string, alias: string | undefined, currentSessionID: string): void {
    if (!alias) {
      return;
    }

    const existing = this.getMemberByAlias(roomCode, alias);
    if (existing && existing.sessionID !== currentSessionID) {
      throw new Error(`Alias ${alias} is already in use in room ${roomCode}.`);
    }
  }

  private upsertMember(roomCode: string, sessionID: string, alias: string | undefined, role: RelayRoomMemberRole, now: number): void {
    this.database
      .prepare(`
        INSERT INTO relay_room_members (room_code, session_id, alias, role, membership_status, joined_at, updated_at)
        VALUES (?, ?, ?, ?, 'active', ?, ?)
        ON CONFLICT(room_code, session_id) DO UPDATE SET
          alias = excluded.alias,
          role = excluded.role,
          membership_status = 'active',
          updated_at = excluded.updated_at
      `)
      .run(roomCode, sessionID, alias ?? null, role, now, now);
  }

  private hydrate(row: RelayRoomRow): RelayRoom {
    return {
      roomCode: row.room_code,
      kind: row.room_kind,
      createdBySessionID: row.created_by_session_id,
      joinedSessionID: row.joined_session_id ?? undefined,
      status: row.status,
      createdAt: row.created_at,
      joinedAt: row.joined_at ?? undefined,
      updatedAt: row.updated_at
    };
  }

  private hydrateMember(row: RelayRoomMemberRow): RelayRoomMember {
    return {
      roomCode: row.room_code,
      sessionID: row.session_id,
      alias: row.alias ?? undefined,
      role: row.role,
      membershipStatus: row.membership_status,
      joinedAt: row.joined_at,
      updatedAt: row.updated_at
    };
  }
}
