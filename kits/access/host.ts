import type { HostExtension, HostExtensionContext } from "tau/host-extension";
import { createAccessExtension } from "./gate.js";
import type { AccessLevel } from "./protocol.js";
import {
  ACCESS_HOST_EXTENSION_ID,
  ACCESS_LEVEL_EVENT,
  ACCESS_THREAD_LEVEL_CALLERS,
  ACCESS_THREAD_LEVEL_COMMAND,
  DEFAULT_ACCESS_LEVEL,
  isAccessLevel,
  strictestAccessLevel,
} from "./protocol.js";

/**
 * Access Kit's host entry. It owns the access level, contributes the Pi gate
 * extension to every runtime, and tells external runtimes which permission
 * policy to launch with. Without it every tool runs, which is what Pi does.
 */
export function createAccessHostExtension(initialLevel: AccessLevel = DEFAULT_ACCESS_LEVEL): HostExtension {
  return {
    id: ACCESS_HOST_EXTENSION_ID,
    name: "Access Kit",
    activate(context: HostExtensionContext) {
      let level = initialLevel;
      const threadLevels = new Map<string, AccessLevel>();
      const { services } = context;
      services.registerRuntimeExtension("tau-access", createAccessExtension({
        level: (sessionId) => strictestAccessLevel(level, sessionId ? threadLevels.get(sessionId) : undefined),
        onBlocked: (toolName, reason) => services.log("access.blocked", `${toolName}: ${reason}`),
      }));
      services.setPermissionLevel(() => level);
      context.registerCommand("level", () => level);
      context.registerCommand("set-level", (input) => {
        const requested = input && typeof input === "object" ? (input as { level?: unknown }).level : undefined;
        if (!isAccessLevel(requested)) throw new Error("Access level must be read-only, ask or full.");
        if (requested !== level) {
          level = requested;
          services.log("access.level", level);
          context.emit(ACCESS_LEVEL_EVENT, level);
        }
        return level;
      });
      context.registerCommand(ACCESS_THREAD_LEVEL_COMMAND, (input) => {
        const fields = input && typeof input === "object" ? input as { threadId?: unknown; level?: unknown } : {};
        if (typeof fields.threadId !== "string" || !fields.threadId) throw new Error('thread-level needs "threadId".');
        if (fields.level === null || fields.level === undefined) threadLevels.delete(fields.threadId);
        else if (isAccessLevel(fields.level)) threadLevels.set(fields.threadId, fields.level);
        else throw new Error("Access level must be read-only, ask or full.");
        return strictestAccessLevel(level, threadLevels.get(fields.threadId));
      }, { callers: ACCESS_THREAD_LEVEL_CALLERS });
      return () => { services.setPermissionLevel(undefined); };
    },
  };
}

export default createAccessHostExtension;
