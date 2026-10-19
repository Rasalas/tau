/** What a runtime kit says about its session database; imports nothing, so both halves read it. */
export interface SessionDatabaseStatus {
  /** Database file plus its write-ahead log. */
  sizeBytes: number;
  /** Free pages a reclaim would give back. */
  reclaimableBytes: number;
  /** The last reclaim that freed space. */
  lastReclaim?: { at: number; bytes: number };
  /** Freed by this call. */
  reclaimedBytes?: number;
  /** Writes were pending, so reclaiming stopped early. */
  deferred?: boolean;
}

/** What a session store lends to Settings → Storage. */
export interface SessionDatabase {
  databaseStatus(): Promise<SessionDatabaseStatus>;
  reclaim(): Promise<SessionDatabaseStatus>;
}

/** The commands every kit with a session database answers for Workspace Kit's Storage page. */
export const SESSION_DATABASE_COMMAND = "session-database";
export const SESSION_DATABASE_RECLAIM_COMMAND = "session-database-reclaim";
export const SESSION_DATABASE_CALLER = "tau.workspace";
