import type { HostExtensionContext } from "tau/host-extension";
import { SESSION_DATABASE_CALLER, SESSION_DATABASE_COMMAND, SESSION_DATABASE_RECLAIM_COMMAND, type SessionDatabase } from "./session-database-protocol.js";

/** Answers Settings → Storage about this kit's session database. */
export function registerSessionDatabase(context: Pick<HostExtensionContext, "registerCommand">, database: SessionDatabase): void {
  context.registerCommand(SESSION_DATABASE_COMMAND, () => database.databaseStatus(), { access: "read", callers: [SESSION_DATABASE_CALLER] });
  context.registerCommand(SESSION_DATABASE_RECLAIM_COMMAND, () => database.reclaim(), { long: true, callers: [SESSION_DATABASE_CALLER] });
}
