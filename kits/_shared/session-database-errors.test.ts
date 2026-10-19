import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { sqliteRecoveryMessage } from "./session-database-errors.js";

function failure(action: (db: DatabaseSync) => void): unknown {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE entries (payload BLOB)");
  try { action(db); } catch (error) { return error; } finally { db.close(); }
  throw new Error("expected the statement to fail");
}

it("explains a full database from the real driver error", () => {
  const error = failure((db) => { db.exec("PRAGMA max_page_count = 2"); db.exec("INSERT INTO entries VALUES (zeroblob(16384))"); });
  expect(sqliteRecoveryMessage((error as { errcode?: number }).errcode)).toMatch(/SQLITE_FULL.*Free some space, then retry/u);
});

it("explains a read-only database from the real driver error", () => {
  const error = failure((db) => { db.exec("PRAGMA query_only = ON"); db.exec("INSERT INTO entries VALUES (1)"); });
  expect(sqliteRecoveryMessage((error as { errcode?: number }).errcode)).toMatch(/SQLITE_READONLY.*writable/u);
});

it.each([
  [5, "SQLITE_BUSY", "Wait a moment"],
  [10 | (3 << 8), "SQLITE_IOERR", "free disk space"],
  [11, "SQLITE_CORRUPT", "Keep a copy"],
  [14 | (6 << 8), "SQLITE_CANTOPEN", "writable"],
  [26, "SQLITE_NOTADB", "Keep a copy"],
])("maps result code %i to %s with a next step", (code, name, step) => {
  const message = sqliteRecoveryMessage(code)!;
  expect(message).toContain(name);
  expect(message).toContain(step);
});

it("leaves unknown or missing codes to the driver text", () => {
  expect(sqliteRecoveryMessage(1)).toBeUndefined();
  expect(sqliteRecoveryMessage(undefined)).toBeUndefined();
});
