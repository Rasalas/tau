import type { AgentRuntimeAdapter } from "tau/host-extension";
import { OPENCODE_BACKEND_KIND } from "./protocol.js";

export interface OpenCodeRuntimeAdapter extends AgentRuntimeAdapter {
  /** `opencode`, or `opencode@<instance>` for another instance. */
  readonly id: string;
  readonly capabilities: { readonly skillInvocationDialect: "opencode"; readonly ownsModelSelection: false; readonly interactiveApprovals: true; readonly fileAttachments: true; readonly modes: readonly ["plan"] };
}

/** The adapter identity core keys dialect and capabilities on; the backend, not a transport, runs the turns. */
export function createOpenCodeRuntimeAdapter(kind: string = OPENCODE_BACKEND_KIND): OpenCodeRuntimeAdapter {
  return {
    id: kind,
    // OpenCode's plan agent.
    capabilities: { skillInvocationDialect: "opencode", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true, modes: ["plan"] },
    transport: {
      sendPrompt: async () => { throw new Error("OpenCode threads run through their backend, not a transport."); },
      abort: async () => undefined,
    },
  };
}
