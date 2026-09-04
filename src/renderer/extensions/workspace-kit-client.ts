import { WORKSPACE_HOST_EXTENSION_ID, createWorkspaceHostClient } from "../../shared/workspace-kit-protocol";
import { HostUnavailableError } from "../extension-system";
import { getHostClient } from "../host-client-context";

/**
 * Workspace Kit's host entry, reached through the generic extension channel.
 * Shared by the kit's views and, until its orchestration moves out of App, by
 * App itself. Built at module scope, so it reads the ambient client `main.tsx`
 * installs rather than one threaded through props.
 */
export const workspaceKit = createWorkspaceHostClient((command, input) => {
  const client = getHostClient();
  return client
    ? client.invokeHostExtension(WORKSPACE_HOST_EXTENSION_ID, command, input)
    : Promise.reject(new HostUnavailableError());
});
