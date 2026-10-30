import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import { createAccessExtension, gateToolCall } from "./gate.js";
import type { AccessLevel } from "./protocol.js";
import {
  ACCESS_HOST_EXTENSION_ID,
  ACCESS_LEVEL_EVENT,
  ACCESS_THREAD_LEVEL_CALLERS,
  ACCESS_THREAD_LEVEL_COMMAND,
  ACCESS_THREAD_LEVEL_OF_CALLERS,
  ACCESS_THREAD_LEVEL_OF_COMMAND,
  ACCESS_THREAD_NARROWING_COMMAND,
  ACCESS_THREAD_NARROWING_EVENT,
  DEFAULT_ACCESS_LEVEL,
  ACCESS_LEVEL_KEY as LEVEL_KEY,
  isAccessLevel,
  strictestAccessLevel,
} from "./protocol.js";

/**
 * Access Kit's host entry. It owns the access level, contributes the Pi gate
 * extension to every runtime and the same gate to the host's MCP tools, and
 * tells external runtimes which permission policy to launch with. Without it every tool runs, which is what Pi does.
 * The level comes from the host's config (`values.tau.access.level`); a client
 * sends `set-level` only for a choice its user made there.
 */
/** Not an extension id, so no kit's own narrowing can collide with the host's. */
const CORE_NARROWING = "tau core";

export function createAccessHostExtension(initialLevel: AccessLevel = DEFAULT_ACCESS_LEVEL): HostExtension {
  return {
    id: ACCESS_HOST_EXTENSION_ID,
    name: "Access",
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const configured = async (): Promise<AccessLevel | undefined> => {
        const value = (await services.settings?.().catch(() => undefined))?.values[LEVEL_KEY];
        return isAccessLevel(value) ? value : undefined;
      };
      // Read before the gate exists, so no turn runs at a level the config does not hold.
      let level = await configured() ?? initialLevel;
      // Each kit narrows a thread on its own: lifting one kit's narrowing never lifts another's.
      const threadLevels = new Map<string, Map<string, AccessLevel>>();
      const narrowing = (sessionId: string): AccessLevel | undefined => {
        let strictest: AccessLevel | undefined;
        for (const value of threadLevels.get(sessionId)?.values() ?? []) strictest = strictest === undefined ? value : strictestAccessLevel(strictest, value);
        return strictest;
      };
      const apply = (next: AccessLevel) => {
        if (next === level) return;
        level = next;
        services.log("access.level", level);
        context.emit(ACCESS_LEVEL_EVENT, level);
      };
      // A read that started before a `set-level` would put the old level back.
      let generation = 0;
      const stopConfig = services.observeConfigChanges((change) => {
        if (change.kind !== "config") return;
        const started = ++generation;
        void configured().then((next) => { if (next && started === generation) apply(next); });
      });
      const levelFor = (sessionId?: string) => strictestAccessLevel(level, sessionId ? narrowing(sessionId) : undefined);
      const onBlocked = (toolName: string, reason: string) => services.log("access.blocked", `${toolName}: ${reason}`);
      services.registerRuntimeExtension("tau-access", createAccessExtension({ level: levelFor, onBlocked }));
      // Tau's own tools reach other runtimes over MCP; the same decision gates them there.
      const releaseMcpGate = services.mcp.gate((call) => gateToolCall(levelFor(call.threadId), call.toolName, call.input, call.confirm, onBlocked, { origin: "tau", annotations: call.annotations }));
      services.setPermissionLevel(levelFor);
      context.registerCommand("level", () => level, { access: "read", callers: ["tau.scheduling"] });
      context.registerCommand("set-level", (input) => {
        const requested = input && typeof input === "object" ? (input as { level?: unknown }).level : undefined;
        if (!isAccessLevel(requested)) throw new Error("Access level must be read-only, ask, auto or full.");
        generation++;
        apply(requested);
        return level;
      });
      // Only the machine's owner, the host and the named kits narrow or lift a thread; a paired device never.
      context.registerCommand(ACCESS_THREAD_LEVEL_COMMAND, (input, call) => {
        const fields = input && typeof input === "object" ? input as { threadId?: unknown; level?: unknown } : {};
        if (typeof fields.threadId !== "string" || !fields.threadId) throw new Error('thread-level needs "threadId".');
        // The host's own narrowing (an MCP client's ceiling, ADR 0046) has a slot no kit can name.
        const source = call.extension ?? CORE_NARROWING;
        const before = narrowing(fields.threadId);
        const levels = threadLevels.get(fields.threadId) ?? new Map<string, AccessLevel>();
        if (fields.level === null || fields.level === undefined) levels.delete(source);
        else if (isAccessLevel(fields.level)) levels.set(source, fields.level);
        else throw new Error("Access level must be read-only, ask, auto or full.");
        if (levels.size) threadLevels.set(fields.threadId, levels); else threadLevels.delete(fields.threadId);
        if (narrowing(fields.threadId) !== before) context.emit(ACCESS_THREAD_NARROWING_EVENT, { threadId: fields.threadId });
        return levelFor(fields.threadId);
      }, { callers: ACCESS_THREAD_LEVEL_CALLERS, access: "owner" });
      context.registerCommand(ACCESS_THREAD_LEVEL_OF_COMMAND, (input) => {
        const threadId = input && typeof input === "object" ? (input as { threadId?: unknown }).threadId : undefined;
        if (typeof threadId !== "string" || !threadId) throw new Error('thread-level-of needs "threadId".');
        return levelFor(threadId);
      }, { callers: ACCESS_THREAD_LEVEL_OF_CALLERS });
      // Read-only: a device that may only look still sees how far a thread may go.
      context.registerCommand(ACCESS_THREAD_NARROWING_COMMAND, (input) => {
        const threadId = input && typeof input === "object" ? (input as { threadId?: unknown }).threadId : undefined;
        if (typeof threadId !== "string" || !threadId) throw new Error('thread-narrowing needs "threadId".');
        return narrowing(threadId) ?? null;
      }, { access: "read" });
      return () => { stopConfig(); releaseMcpGate(); services.setPermissionLevel(undefined); };
    },
  };
}

export default createAccessHostExtension;
