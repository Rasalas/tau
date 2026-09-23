import type { AgentRuntimeAdapter } from "tau/host-extension";
import { CURSOR_BACKEND_KIND } from "./protocol.js";

export interface CursorRuntimeAdapter extends AgentRuntimeAdapter {
  /** `cursor`, or `cursor@<instance>` for another instance. */
  readonly id: string;
  readonly capabilities: { readonly skillInvocationDialect: "cursor"; readonly ownsModelSelection: false; readonly interactiveApprovals: true; readonly fileAttachments: true; readonly modes: readonly ["plan"] };
}

/** The adapter identity core keys dialect and capabilities on; the backend, not a transport, runs the turns. */
export function createCursorRuntimeAdapter(kind: string = CURSOR_BACKEND_KIND): CursorRuntimeAdapter {
  return {
    id: kind,
    // Cursor's plan mode.
    capabilities: { skillInvocationDialect: "cursor", ownsModelSelection: false, interactiveApprovals: true, fileAttachments: true, modes: ["plan"] },
    transport: {
      sendPrompt: async () => { throw new Error("Cursor threads run through their backend, not a transport."); },
      abort: async () => undefined,
    },
  };
}
