import type { AccessLevel } from "../../shared/access-kit-protocol.js";
import { ACCESS_HOST_EXTENSION_ID, ACCESS_LEVEL_EVENT, DEFAULT_ACCESS_LEVEL, isAccessLevel } from "../../shared/access-kit-protocol.js";
import { createAccessExtension } from "../access-extension.js";
import type { HostExtension, HostExtensionContext } from "../host-extensions.js";
import { runtimePermissionPolicy } from "../runtime-adapters.js";

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
      const { services } = context;
      services.registerRuntimeExtension("tau-access", createAccessExtension({
        level: () => level,
        onBlocked: (toolName, reason) => services.log("access.blocked", `${toolName}: ${reason}`),
      }));
      services.setPermissionPolicy(() => runtimePermissionPolicy(level));
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
      return () => { services.setPermissionPolicy(undefined); };
    },
  };
}
