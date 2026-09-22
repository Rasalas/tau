import type { AgentRuntimeAdapter } from "tau/host-extension";
import { ANTIGRAVITY_BACKEND_KIND } from "./protocol.js";

export interface AntigravityRuntimeAdapter extends AgentRuntimeAdapter {
  readonly id: typeof ANTIGRAVITY_BACKEND_KIND;
  readonly capabilities: { readonly skillInvocationDialect: "antigravity"; readonly ownsModelSelection: false; readonly interactiveApprovals: true; readonly fileAttachments: true };
}

/** The adapter identity core keys dialect and capabilities on; the backend, not a transport, runs the turns. */
export function createAntigravityRuntimeAdapter(): AntigravityRuntimeAdapter {
  return {
    id: ANTIGRAVITY_BACKEND_KIND,
    capabilities: { skillInvocationDialect: "antigravity", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true },
    transport: {
      sendPrompt: async () => { throw new Error("Antigravity threads run through their backend, not a transport."); },
      abort: async () => undefined,
    },
  };
}
