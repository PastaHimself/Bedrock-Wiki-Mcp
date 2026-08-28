import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DatabaseMode = "readwrite" | "readonly";
export type JournalMode = "wal" | "delete";

export interface OpenDatabaseOptions {
  mode?: DatabaseMode;
  timeoutMs?: number;
  journalMode?: JournalMode;
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): DatabaseSync {
  const mode = options.mode ?? "readwrite";
  const timeout = options.timeoutMs ?? 5_000;
  const journalMode = options.journalMode ?? "wal";
  if (!Number.isSafeInteger(timeout) || timeout < 0) throw new RangeError("timeoutMs must be a non-negative safe integer");

  if (path !== ":memory:" && mode === "readwrite") mkdirSync(dirname(path), { recursive: true });

  const database = new DatabaseSync(path, {
    readOnly: mode === "readonly",
    timeout,
  });

  database.exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = ${timeout};`);
  if (mode === "readonly") {
    database.exec("PRAGMA query_only = ON;");
  } else {
    if (path !== ":memory:") {
      database.exec(`PRAGMA journal_mode = ${journalMode === "wal" ? "WAL" : "DELETE"};`);
    }
    database.exec("PRAGMA synchronous = NORMAL;");
  }

  return database;
}
