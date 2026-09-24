import type { ComponentType } from "react";
import type { WorkbenchActions } from "tau";

export const ENVIRONMENTS_EXTENSION_ID = "tau.environments";
export const MACHINES_SETTINGS_PAGE = "environments.machines";

/** Workspace Kit's desktop service (`kits/workspace/protocol.ts`); the rail draws what is registered here. */
export const WORKSPACE_STORE_SERVICE = "tau.workspace/store";
export interface WorkspaceRailSlice {
  /** Absent in a Workspace Kit before API 1.13.0; the rail then lists this machine's threads only. */
  registerRailSection?(section: ComponentType<{ actions: WorkbenchActions }>): () => void;
}
