import { WORKSPACE_HOST_EXTENSION_ID, createWorkspaceHostClient } from "../../shared/workspace-kit-protocol";
import { HostUnavailableError } from "../extension-system";

/**
 * Workspace Kit's host entry, reached through the generic extension channel.
 * Shared by the kit's views and, until its orchestration moves out of App, by
 * App itself.
 */
export const workspaceKit = createWorkspaceHostClient((command, input) => window.tau
  ? window.tau.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, command, input)
  : Promise.reject(new HostUnavailableError()));
