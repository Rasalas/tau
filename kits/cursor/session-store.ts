import type { PersistedJsonLogger } from "tau/host-extension";
import { AcpSessionStore, type AcpSelection, type AcpSessionRecord, type AcpStoredMessage, type AcpStoredModel } from "../_acp/session-store.js";

/**
 * App-data persistence for Cursor threads (`kits/_acp/session-store.ts`).
 * The Cursor CLI keeps the full conversation itself, in its home.
 */
export type CursorStoredMessage = AcpStoredMessage;
export type CursorSessionRecord = AcpSessionRecord<"cursor">;
export type CursorStoredModel = AcpStoredModel;
export type CursorSelection = AcpSelection;
export { storedModel } from "../_acp/session-store.js";

export class CursorSessionStore extends AcpSessionStore<"cursor"> {
  constructor(options: { filePath: string; now?(): number; logger?: PersistedJsonLogger }) {
    super({ ...options, backendKind: "cursor", agent: "Cursor" });
  }

  static defaultPath(sessionsDir: string): string {
    return AcpSessionStore.pathFor(sessionsDir, "cursor");
  }
}
