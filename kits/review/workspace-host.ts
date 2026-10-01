import { AsyncLocalStorage } from "node:async_hooks";
import type { HostExtensionContext } from "tau/host-extension";
import { WORKSPACE_HOST_EXTENSION_ID } from "./protocol.js";

const fields = (input: unknown): Record<string, unknown> => input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};

/** Nested Workspace calls keep the Review command's checkout, independently for concurrent requests. */
export function workspaceCommandContext(original: HostExtensionContext): HostExtensionContext {
  const workspace = new AsyncLocalStorage<string | undefined>();
  return {
    ...original,
    registerCommand: (name, handler, options) => original.registerCommand(name, (input, call) => {
      const named = fields(input).workspace;
      return workspace.run(typeof named === "string" ? named : undefined, () => handler(input, call));
    }, options),
    invokeHostExtension: (extension, command, input) => {
      const named = workspace.getStore();
      const item = fields(input);
      return original.invokeHostExtension(extension, command, extension === WORKSPACE_HOST_EXTENSION_ID && named && item.workspace === undefined && item.cwd === undefined
        ? { ...item, workspace: named } : input);
    },
  };
}
