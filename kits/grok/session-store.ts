import type { PersistedJsonLogger } from "tau/host-extension";
import { AcpSessionStore, type AcpSessionRecord } from "../_acp/session-store.js";

/**
 * App-data persistence for Grok threads (`kits/_acp/session-store.ts`), each
 * turn's usage included. The Grok CLI keeps the full conversation itself,
 * under its home's `sessions/`.
 */
export type GrokSessionRecord = AcpSessionRecord<"grok">;

export class GrokSessionStore extends AcpSessionStore<"grok"> {
  constructor(options: { filePath: string; now?(): number; logger?: PersistedJsonLogger }) {
    super({ ...options, backendKind: "grok", agent: "Grok" });
  }

  static defaultPath(sessionsDir: string): string {
    return AcpSessionStore.pathFor(sessionsDir, "grok");
  }
}
