/** One sentence and one next step per SQLite failure a user can fix; keyed by the primary result code. */
const RECOVERY: Readonly<Record<number, string>> = {
  5: "The session database is busy (SQLITE_BUSY). Wait a moment, then retry. If it keeps happening, close other Tau windows or hosts using the same data folder.",
  6: "The session database is locked (SQLITE_LOCKED). Wait a moment, then retry. If it keeps happening, check the host log for the process holding it.",
  8: "The session database is read-only (SQLITE_READONLY). Check that the Tau data folder is writable and its disk is mounted read-write, then retry.",
  10: "Tau could not read or write the session database (SQLITE_IOERR). Check free disk space and disk health, then retry.",
  11: "The session database looks damaged (SQLITE_CORRUPT). Keep a copy of the Tau data folder and check the host log before restoring a backup.",
  13: "Tau could not save this change because the disk is full (SQLITE_FULL). Free some space, then retry.",
  14: "Tau could not open the session database (SQLITE_CANTOPEN). Check that the Tau data folder exists, is writable and has free space, then retry.",
  26: "The session database file is not a database (SQLITE_NOTADB). Keep a copy of the Tau data folder and check the host log before restoring a backup.",
};

/** The user-facing text for a worker failure, or undefined when the code has no known remedy. */
export function sqliteRecoveryMessage(errcode: unknown): string | undefined {
  // node:sqlite reports extended result codes; the low byte is the primary one.
  return typeof errcode === "number" && Number.isInteger(errcode) && errcode > 0 ? RECOVERY[errcode & 0xff] : undefined;
}
