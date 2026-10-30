import type { HostExtensionContext } from "tau/host-extension";
import { SESSION_DATABASE_CALLER, SESSION_DATABASE_COMMAND, SESSION_DATABASE_RECLAIM_COMMAND, type SessionDatabase } from "./session-database-protocol.js";

/** Answers Settings → Storage about this kit's session database. */
export function registerSessionDatabase(context: Pick<HostExtensionContext, "registerCommand">, database: SessionDatabase): void {
  registerSessionDatabases(context, () => [database]);
}

/** Runtime registries may own one database per configured agent. Register their commands once. */
export function registerSessionDatabases(context: Pick<HostExtensionContext, "registerCommand">, databases: () => readonly SessionDatabase[]): void {
  const report = async (reclaim: boolean) => {
    const statuses = await Promise.all(databases().map(database => reclaim ? database.reclaim() : database.databaseStatus()));
    return {
      sizeBytes: statuses.reduce((total, status) => total + status.sizeBytes, 0),
      reclaimableBytes: statuses.reduce((total, status) => total + status.reclaimableBytes, 0),
      ...(reclaim ? { reclaimedBytes: statuses.reduce((total, status) => total + (status.reclaimedBytes ?? 0), 0) } : {}),
      ...(statuses.some(status => status.deferred) ? { deferred: true } : {}),
      ...statuses.map(status => status.lastReclaim).filter(status => status !== undefined).sort((a, b) => b.at - a.at).slice(0, 1).map(lastReclaim => ({ lastReclaim }))[0],
    };
  };
  context.registerCommand(SESSION_DATABASE_COMMAND, () => report(false), { access: "read", callers: [SESSION_DATABASE_CALLER] });
  context.registerCommand(SESSION_DATABASE_RECLAIM_COMMAND, () => report(true), { long: true, callers: [SESSION_DATABASE_CALLER] });
}
