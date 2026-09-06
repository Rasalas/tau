import type { ThreadBackendKind, UiComposerCommand } from "../shared/contracts.js";
import type { HostPackageLoadResult } from "./extension-packages.js";
import type { HostExtension, HostPlatform } from "./host-extensions.js";
import type { HostLogger } from "./host-log.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";

export interface PiHostOptions {
  /** Full errors (stack, cause, name) go here; the renderer keeps getting only the message. */
  logger?: HostLogger;
  /** The Pi adapter; tests substitute one. Other backends register through the seam. */
  runtimeAdapter?: AgentRuntimeAdapter;
  /** Backend for new threads when no existing session metadata applies. */
  defaultBackendKind?: ThreadBackendKind;
  /** Commands available to non-Pi backends. Pi discovers its own resources. */
  runtimeCommands?: readonly UiComposerCommand[];
  /** Host entries of desktop kits, activated before the first runtime opens. */
  hostExtensions?: readonly HostExtension[];
  /** Native platform services used by host extensions. */
  platform?: HostPlatform;
  /** Host halves of extension packages on disk for the active workspace. */
  hostExtensionPackages?: (cwd: string) => Promise<HostPackageLoadResult>;
  /** Where user grants live; tests point this at a temp file. */
  grantsFilePath?: string;
  /** Where per-thread cost totals are cached; without one they last only for this run. */
  sessionUsageCachePath?: string;
  /** Where the index keeps which thread spawned which; defaults to memory only. */
  sessionLineageCachePath?: string;
  /** Mints the ids clients address workspaces by; without one they are per-run. */
  workspaceIdentity?: WorkspaceIdentity;
}
