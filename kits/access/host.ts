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
export function createAccessHostExtension(initialLevel: AccessLevel = DEFAULT_ACCESS_LEVEL): HostExtension {
  return {
    id: ACCESS_HOST_EXTENSION_ID,
    name: "Access Kit",
    async activate(context: HostExtensionContext) {
      const { services } = context;
      const configured = async (): Promise<AccessLevel | undefined> => {
        const value = (await services.settings?.().catch(() => undefined))?.values[LEVEL_KEY];
        return isAccessLevel(value) ? value : undefined;
      };
      // Read before the gate exists, so no turn runs at a level the config does not hold.
      let level = await configured() ?? initialLevel;
      const threadLevels = new Map<string, AccessLevel>();
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
      const levelFor = (sessionId?: string) => strictestAccessLevel(level, sessionId ? threadLevels.get(sessionId) : undefined);
      const onBlocked = (toolName: string, reason: string) => services.log("access.blocked", `${toolName}: ${reason}`);
      services.registerRuntimeExtension("tau-access", createAccessExtension({ level: levelFor, onBlocked }));
      // Tau's own tools reach other runtimes over MCP; the same decision gates them there.
      const releaseMcpGate = services.mcp.gate((call) => gateToolCall(levelFor(call.threadId), call.toolName, call.input, call.confirm, onBlocked));
      services.setPermissionLevel(() => level);
      context.registerCommand("level", () => level, { access: "read" });
      context.registerCommand("set-level", (input) => {
        const requested = input && typeof input === "object" ? (input as { level?: unknown }).level : undefined;
        if (!isAccessLevel(requested)) throw new Error("Access level must be read-only, ask, auto or full.");
        generation++;
        apply(requested);
        return level;
      });
      context.registerCommand(ACCESS_THREAD_LEVEL_COMMAND, (input) => {
        const fields = input && typeof input === "object" ? input as { threadId?: unknown; level?: unknown } : {};
        if (typeof fields.threadId !== "string" || !fields.threadId) throw new Error('thread-level needs "threadId".');
        if (fields.level === null || fields.level === undefined) threadLevels.delete(fields.threadId);
        else if (isAccessLevel(fields.level)) threadLevels.set(fields.threadId, fields.level);
        else throw new Error("Access level must be read-only, ask, auto or full.");
        return strictestAccessLevel(level, threadLevels.get(fields.threadId));
      }, { callers: ACCESS_THREAD_LEVEL_CALLERS });
      context.registerCommand(ACCESS_THREAD_LEVEL_OF_COMMAND, (input) => {
        const threadId = input && typeof input === "object" ? (input as { threadId?: unknown }).threadId : undefined;
        if (typeof threadId !== "string" || !threadId) throw new Error('thread-level-of needs "threadId".');
        return levelFor(threadId);
      }, { callers: ACCESS_THREAD_LEVEL_OF_CALLERS });
      return () => { stopConfig(); releaseMcpGate(); services.setPermissionLevel(undefined); };
    },
  };
}

export default createAccessHostExtension;
