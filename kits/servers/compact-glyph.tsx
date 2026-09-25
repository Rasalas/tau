import { Server } from "lucide-react";
import { useWorkbenchShell } from "tau";
import { worstState } from "./status-model.js";
import { StatusDot, useServersStatus } from "./status-parts.js";
import type { ServersStatusStore } from "./status-store.js";

/** The thread's project on a compact client; outside the workbench there is none. */
export function useThreadCwd(): string | undefined {
  try {
    return useWorkbenchShell().snapshot?.cwd;
  } catch {
    return undefined;
  }
}

/** The sheet's glyph in the title bar, with the project's worst state as a dot. */
export function createCompactGlyph(store: ServersStatusStore) {
  return function ServersGlyph({ size = 16 }: { size?: number }) {
    const { status } = useServersStatus(store, useThreadCwd());
    const state = worstState((status?.targets ?? []).map((target) => target.state));
    return <span className="servers-glyph"><Server size={size} />{state ? <StatusDot state={state} /> : null}</span>;
  };
}
