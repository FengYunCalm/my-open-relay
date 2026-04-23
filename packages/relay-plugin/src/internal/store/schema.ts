import type { SqliteDatabase } from "./sqlite.js";

export function initializeRelaySchema(database: SqliteDatabase): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS relay_tasks (
      task_id TEXT PRIMARY KEY,
      context_id TEXT,
      status TEXT NOT NULL,
      request_message_json TEXT NOT NULL,
      latest_message_json TEXT,
      artifacts_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      dedupe_key TEXT UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_session_links (
      task_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_rooms (
      room_code TEXT PRIMARY KEY,
      room_kind TEXT NOT NULL DEFAULT 'private',
      created_by_session_id TEXT NOT NULL,
      joined_session_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      joined_at INTEGER,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_room_members (
      room_code TEXT NOT NULL,
      session_id TEXT NOT NULL,
      alias TEXT,
      role TEXT NOT NULL,
      membership_status TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (room_code, session_id)
    );

    CREATE TABLE IF NOT EXISTS relay_threads (
      thread_id TEXT PRIMARY KEY,
      room_code TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT,
      direct_key TEXT UNIQUE,
      created_by_session_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_thread_participants (
      thread_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      last_read_seq INTEGER NOT NULL DEFAULT 0,
      last_notified_seq INTEGER NOT NULL DEFAULT 0,
      joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, session_id)
    );

    CREATE TABLE IF NOT EXISTS relay_messages (
      thread_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      sender_session_id TEXT NOT NULL,
      message_type TEXT NOT NULL,
      body_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (thread_id, seq),
      UNIQUE (thread_id, message_id)
    );

    CREATE TABLE IF NOT EXISTS relay_team_runs (
      run_id TEXT PRIMARY KEY,
      manager_session_id TEXT NOT NULL,
      room_code TEXT NOT NULL UNIQUE,
      task TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_team_workers (
      run_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      alias TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      last_note TEXT,
      workflow_source TEXT,
      workflow_phase TEXT,
      progress INTEGER,
      evidence_json TEXT,
      created_at INTEGER NOT NULL,
      joined_at INTEGER,
      ready_at INTEGER,
      cleaned_up_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (run_id, session_id)
    );

    CREATE INDEX IF NOT EXISTS idx_relay_room_members_session ON relay_room_members(session_id);
    CREATE INDEX IF NOT EXISTS idx_relay_threads_room ON relay_threads(room_code);
    CREATE INDEX IF NOT EXISTS idx_relay_thread_participants_session ON relay_thread_participants(session_id);
    CREATE INDEX IF NOT EXISTS idx_relay_messages_thread_seq ON relay_messages(thread_id, seq);
    CREATE INDEX IF NOT EXISTS idx_relay_team_runs_manager ON relay_team_runs(manager_session_id);
    CREATE INDEX IF NOT EXISTS idx_relay_team_workers_session ON relay_team_workers(session_id);
  `);

  try {
    database.exec(`ALTER TABLE relay_rooms ADD COLUMN room_kind TEXT NOT NULL DEFAULT 'private';`);
  } catch {}

  try {
    database.exec(`ALTER TABLE relay_room_members ADD COLUMN alias TEXT;`);
  } catch {}

  try {
    database.exec(`ALTER TABLE relay_team_workers ADD COLUMN workflow_source TEXT;`);
  } catch {}

  try {
    database.exec(`ALTER TABLE relay_team_workers ADD COLUMN workflow_phase TEXT;`);
  } catch {}

  try {
    database.exec(`ALTER TABLE relay_team_workers ADD COLUMN progress INTEGER;`);
  } catch {}

    try {
      database.exec(`ALTER TABLE relay_team_workers ADD COLUMN evidence_json TEXT;`);
    } catch {}

    try {
      database.exec(`ALTER TABLE relay_team_workers ADD COLUMN cleaned_up_at INTEGER;`);
    } catch {}
}
