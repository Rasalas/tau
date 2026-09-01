import type { HostExtension } from "../host-extensions.js";
import { createWorkspaceHostExtension } from "./workspace-host-extension.js";

/** Host entries of the bundled kits. Safe mode starts the host with none of them. */
export function bundledHostExtensions(): HostExtension[] {
  return [createWorkspaceHostExtension()];
}
