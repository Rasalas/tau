import type { AgentRuntimeAdapter } from "tau/host-extension";
import { CODEX_BACKEND_KIND } from "./protocol.js";

export interface CodexRuntimeAdapter extends AgentRuntimeAdapter {
  /** `codex`, or `codex@<instance>` for another instance. */
  readonly id: string;
  readonly capabilities: { readonly skillInvocationDialect: "codex"; readonly ownsModelSelection: false; readonly interactiveApprovals: true; readonly fileAttachments: true };
}

/** The adapter identity core keys dialect and capabilities on; the backend, not a transport, runs the turns. */
export function createCodexRuntimeAdapter(kind: string = CODEX_BACKEND_KIND): CodexRuntimeAdapter {
  return {
    id: kind,
    capabilities: { skillInvocationDialect: "codex", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true },
    transport: {
      sendPrompt: async () => { throw new Error("Codex threads run through their backend, not a transport."); },
      abort: async () => undefined,
    },
  };
}
