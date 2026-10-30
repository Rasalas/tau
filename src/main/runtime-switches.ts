import { existsSync, readFileSync } from "node:fs";
import { writePersistedJson } from "./persisted-json.js";
import { externalThreadPath } from "./pi-host-support.js";
import type { UiMessage, UiSession, UiTurnActivityEntry } from "../shared/contracts.js";
import type { ThreadRuntimeBackend, ThreadBackendCapabilities } from "./runtime-types.js";

export interface RuntimeSwitch {
  kind: string;
  cwd: string;
  title?: string;
  history: UiMessage[];
  /** Target sessions may contain earlier segments. Only newer messages join the visible conversation. */
  offset: number;
  contextPending: boolean;
  sessionPath?: string;
  paths?: string[];
  deleted?: boolean;
  activity?: UiTurnActivityEntry[];
  activityOffset?: number;
}

/** Durable conversation history above provider-owned sessions. A switch never rewrites a provider's past. */
export class RuntimeSwitches {
  private records = new Map<string, RuntimeSwitch>();
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      const value = JSON.parse(readFileSync(path, "utf8")) as { version: number; threads: Record<string, RuntimeSwitch> };
      if (value.version !== 1 || !value.threads || typeof value.threads !== "object") throw new Error("Unsupported runtime switch history.");
      for (const [id, record] of Object.entries(value.threads)) {
        if (!record || typeof record.kind !== "string" || typeof record.cwd !== "string" || !Array.isArray(record.history) || !record.history.every(message => typeof message.id === "string" && typeof message.text === "string") || !Number.isSafeInteger(record.offset) || record.offset < 0 || typeof record.contextPending !== "boolean") throw new Error("Invalid runtime switch history.");
        this.records.set(id, record);
      }
    }
  }
  canonicalPath(path: string): string | undefined {
    for (const [id, record] of this.records) if (!record.deleted && record.paths?.includes(path)) return record.sessionPath ?? externalThreadPath(record.kind, id);
    return undefined;
  }
  get(id: string): RuntimeSwitch | undefined { return this.records.get(id); }
  async set(id: string, record: RuntimeSwitch | undefined): Promise<void> {
    const previous = this.records.get(id);
    if (record) this.records.set(id, record); else this.records.delete(id);
    try { if (this.path) await writePersistedJson(this.path, 1, { threads: Object.fromEntries(this.records) }); }
    catch (error) { if (previous) this.records.set(id, previous); else this.records.delete(id); throw error; }
  }
  shell(session: UiSession): UiSession | undefined {
    const record = this.records.get(session.id);
    if (!record) return session;
    if (record.deleted) return undefined;
    return { ...session, path: record.sessionPath ?? externalThreadPath(record.kind, session.id), backendKind: record.kind, ...(record.title ? { title: record.title } : {}) };
  }
  wrap(backend: ThreadRuntimeBackend): ThreadRuntimeBackend {
    const record = this.records.get(backend.threadId);
    if (!record || record.deleted || record.kind !== backend.kind) return backend;
    const history = record.history;
    const store = this;
    const historyIds = new Set(history.map(message => message.id));
    const capabilities: ThreadBackendCapabilities = {
      ...backend.capabilities,
      conversation: { history: () => history, offset: record.offset, activity: () => record.activity ?? [] },
      activityHistory: {
        load: async () => [...record.activity ?? [], ...(await backend.capabilities.activityHistory?.load() ?? []).slice(record.activityOffset ?? 0)],
        save: entry => backend.capabilities.activityHistory?.save(entry) ?? Promise.resolve(),
      },
    };
    return new Proxy(backend, { get(target, key) {
      if (key === "capabilities") return capabilities;
      if (key === "transcript") return async () => [...history, ...(await target.transcript()).slice(record.offset)];
      if (key === "persist") return async (messages: readonly UiMessage[]) => target.persist(messages.filter(message => !historyIds.has(message.id)));
      if (key === "state") return () => ({ ...target.state(), hasMessages: history.length > 0 || target.state().hasMessages, ...(record.title ? { title: record.title } : {}) });
      if (key === "setTitle") return async (title: string, source: "derived" | "generated" | "renamed") => { await target.setTitle(title, source); await store.set(target.threadId, { ...store.get(target.threadId)!, title }); record.title = title; };
      if (key === "prompt") return async (input: Parameters<ThreadRuntimeBackend["prompt"]>[0]) => {
        // Carry visible conversational context, never shell output, hidden instructions or attached credential bytes.
        const context = record.contextPending ? history.filter(message => !message.excludedFromContext && message.kind !== "shell" && ["user", "assistant"].includes(message.role)).map(message => `${message.role}: ${message.text}`).join("\n\n") : undefined;
        const result = await target.prompt({ ...input, ...(context ? { continuationContext: context } : {}) });
        if (record.contextPending) { await store.set(target.threadId, { ...store.get(target.threadId)!, contextPending: false }); record.contextPending = false; }
        return result;
      };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }
}
