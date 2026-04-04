import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export type SqliteStatement = {
  run(...args: unknown[]): unknown;
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown;
};

export type SqliteDatabase = {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
};

function openBunDatabase(location: string): SqliteDatabase {
  const { Database } = require("bun:sqlite") as {
    Database: new (location: string, options?: { create?: boolean; readwrite?: boolean }) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...args: unknown[]): unknown;
        get(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown;
      };
      close(): void;
    };
  };

  const database = new Database(location, { create: true });
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run: (...args) => statement.run(...args),
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args)
      };
    },
    close() {
      database.close();
    }
  };
}

function openNodeDatabase(location: string): SqliteDatabase {
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (location: string) => {
      exec(sql: string): void;
      prepare(sql: string): {
        run(...args: unknown[]): unknown;
        get(...args: unknown[]): unknown;
        all(...args: unknown[]): unknown;
      };
      close(): void;
    };
  };

  const database = new DatabaseSync(location);
  return {
    exec(sql) {
      database.exec(sql);
    },
    prepare(sql) {
      const statement = database.prepare(sql);
      return {
        run: (...args) => statement.run(...args),
        get: (...args) => statement.get(...args),
        all: (...args) => statement.all(...args)
      };
    },
    close() {
      database.close();
    }
  };
}

export function openSqliteDatabase(location = ":memory:"): SqliteDatabase {
  try {
    return openBunDatabase(location);
  } catch {
    return openNodeDatabase(location);
  }
}
