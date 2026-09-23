import type { AgentRuntimeAdapter } from "tau/host-extension";
import { GROK_BACKEND_KIND } from "./protocol.js";

export interface GrokRuntimeAdapter extends AgentRuntimeAdapter {
  /** `grok`, or `grok@<instance>` for another instance. */
  readonly id: string;
  readonly capabilities: { readonly skillInvocationDialect: "grok"; readonly ownsModelSelection: false; readonly interactiveApprovals: true; readonly fileAttachments: true; readonly modes: readonly ["plan"] };
}

/** The adapter identity core keys dialect and capabilities on; the backend, not a transport, runs the turns. */
export function createGrokRuntimeAdapter(kind: string = GROK_BACKEND_KIND): GrokRuntimeAdapter {
  return {
    id: kind,
    capabilities: { skillInvocationDialect: "grok", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true, modes: ["plan"] },
    transport: {
      sendPrompt: async () => { throw new Error("Grok threads run through their backend, not a transport."); },
      abort: async () => undefined,
    },
  };
}
