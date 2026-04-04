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
      created_by_session_id TEXT NOT NULL,
      joined_session_id TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      joined_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
}
