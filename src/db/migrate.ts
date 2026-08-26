import type { DatabaseSync } from "node:sqlite";
import { INITIAL_SCHEMA_SQL, SCHEMA_VERSION } from "./migrations/0001-initial.js";

interface UserVersionRow {
  user_version: number;
}

export function getSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as UserVersionRow | undefined;
  return row?.user_version ?? 0;
}

export function migrateDatabase(database: DatabaseSync): void {
  const current = getSchemaVersion(database);
  if (current === SCHEMA_VERSION) return;
  if (current > SCHEMA_VERSION) {
    throw new Error(`Database schema ${current} is newer than supported schema ${SCHEMA_VERSION}`);
  }
  if (current !== 0) {
    throw new Error(`Unsupported migration path from schema ${current} to ${SCHEMA_VERSION}`);
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(INITIAL_SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    database.prepare("INSERT INTO index_meta(key, value) VALUES (?, ?)").run("schema_version", String(SCHEMA_VERSION));
    database.exec("COMMIT");
  } catch (error) {
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
