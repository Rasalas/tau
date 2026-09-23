import type { HostCompletionOptions } from "./host-completion.js";
import type { ThreadBackendKind, UiComposerCommand } from "../shared/contracts.js";
import type { HostPackageLoadResult } from "./extension-packages.js";
import type { HostClientRegistry } from "./host-clients.js";
import type { HostExtension, HostPlatform } from "./host-extensions.js";
import type { HostLogger } from "./host-log.js";
import type { AgentRuntimeAdapter } from "./runtime-adapters.js";
import type { WorkspaceIdentity } from "./workspace-identity.js";

export interface PiHostOptions {
  /** Full errors (stack, cause, name) go here; the renderer keeps getting only the message. */
  logger?: HostLogger;
  /** The Pi adapter; tests substitute one. Other backends register through the seam. */
  runtimeAdapter?: AgentRuntimeAdapter;
  /** The model runtime a kit's small jobs complete on; the user's Pi configuration otherwise. */
  createModelRuntime?: HostCompletionOptions["createRuntime"];
  /** Backend for new threads when no existing session metadata applies. */
  defaultBackendKind?: ThreadBackendKind;
  /** Commands available to non-Pi backends. Pi discovers its own resources. */
  runtimeCommands?: readonly UiComposerCommand[];
  /**
   * Host entries of desktop kits, activated before the first runtime opens. A
   * thunk defers compiling the kits Tau ships until the host starts, which is
   * where their failures belong.
   */
  hostExtensions?: readonly HostExtension[] | (() => Promise<readonly HostExtension[]>);
  /** Native platform services used by host extensions. */
  platform?: HostPlatform;
  /** Host halves of extension packages on disk for the active workspace. */
  hostExtensionPackages?: (cwd: string) => Promise<HostPackageLoadResult>;
  /** Where user grants live; tests point this at a temp file. */
  grantsFilePath?: string;
  /** Where per-thread cost totals are cached; without one they last only for this run. */
  sessionUsageCachePath?: string;
  /** Where the markers of turns in flight live; without one they last only for this run. */
  turnsInFlightPath?: string;
  /** Where deleted threads wait until they are removed for good (`<userData>/thread-trash`). */
  threadTrashDir?: string;
  /** Where the index keeps which thread spawned which; defaults to memory only. */
  sessionLineageCachePath?: string;
  /**
   * Root of the per-extension state folders (`<userData>/kit-state`). Without
   * one, kit state lands in the system temp dir rather than in anyone's home.
   */
  kitStateDir?: string;
  /** Mints the ids clients address workspaces by; without one they are per-run. */
  workspaceIdentity?: WorkspaceIdentity;
  /**
   * Where the transports report their clients. The entry point owns it, because
   * a transport can outlive one host; without one the host counts nobody.
   */
  clients?: HostClientRegistry;
  /**
   * Root of the running checkout. The host watches the kit sources under it
   * while Tau runs from a checkout; an installed app runs prebuilt kits and
   * passes nothing.
   */
  appPath?: string;
  /** How long an unused runtime stays live (default ten minutes); 0 keeps it until eviction. */
  runtimeIdleReleaseMs?: number;
}
