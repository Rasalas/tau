/**
 * `tau/host-extension`: the host-side public API. A bundled kit and an
 * in-process package import this module and nothing else from `src/`.
 *
 * The types are erased at build time. The handful of values re-exported here
 * come from leaf modules only, so a kit that imports one of them does not pull
 * the registry, Pi or Electron into its bundle. Grow this list deliberately and
 * bump `EXTENSION_API_VERSION` when you do.
 */
export type * from "./host-extensions.js";
export type { WindowExtension, WindowExtensionContext, WindowExtensionFactory } from "./window-extensions.js";
export type * from "./runtime-types.js";
export type * from "./runtime-adapters.js";
export type * from "./pi-kit-extensions.js";
export type * from "./model-auth.js";
export type * from "../shared/contracts.js";
// What `services.network` speaks (API 1.13.0).
export type { UiHostEndpoint, UiHostEndpointKind, UiNetworkAccess, UiNetworkCertificate, UiNetworkListener, UiNetworkSettings } from "../shared/connections.js";
// What `host-resources` and `readiness` answer, through `services.machines.request` (API 1.15.0).
export type { HostDisplayKind, HostReadiness, HostResources, RuntimeReadiness, RuntimeReadinessState } from "../shared/host-resources.js";
export { HostAuthorizationError, HostCommandError, type HostAuthorizationDetails } from "./host-extension-errors.js";
// What a project's commands may reach, and the refusal of a runtime that cannot hold them to it (API 1.14.0).
export { executionPolicyRefusal, normalizeAllowedHost } from "./host-execution-policy.js";
export { buildTitleConversation, cleanThreadTitle, textFromContent, type TitleMessage } from "./host-text.js";
export { isSmallModel, smallCompletionModel, type CompletionModelRef } from "./small-completion-model.js";
export { prepareSkillPrompt, skillInvocationCommand, type PreparedSkillPrompt, type SkillRuntimeAdapter } from "./skill-invocation.js";
export {
  readPersistedJson,
  writePersistedJson,
  type PersistedJsonLogger,
  type PersistedJsonRead,
  type ReadPersistedJsonOptions,
  type WritePersistedJsonOptions,
} from "./persisted-json.js";
export { ORIGIN_ENTRY, PARENT_LINK_ENTRY, originEntry, parentLinkEntry } from "./session-lineage.js";
export { DEFAULT_THREAD_MODE, THREAD_MODE_ENTRY, threadModeFromEntries } from "../shared/thread-mode.js";
export { clientMessageFingerprint } from "../shared/client-message-correlation.js";
export { validatePreparedPrompt } from "../shared/prepared-prompt.js";
export { knownSkillNames, parseSkillEnvelope, type ParsedSkillEnvelope } from "../shared/skill-envelope.js";
export type { ExtensionIsolation, ExtensionPermission } from "../shared/extension-permissions.js";
export type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
export { isWorkspaceRelativePath, type WorkspaceRef } from "../shared/workspace-identity.js";
export type { HostActionResult, TranscriptPage } from "../shared/host-protocol.js";
// A machine backend follows pushes and pages its home host. New in API 1.42.0.
export type { HostPushEvent } from "../shared/host-transport.js";
export type { HostTranscriptCursor } from "../shared/transcript-cursor.js";

/**
 * The workspace vocabulary: changed files, diffs, worktrees and editors. Core
 * speaks it too (the stage renders these shapes), so it stays in `src/shared`
 * and is published from here rather than owned by a kit. Turn checkpoints are
 * Workspace Kit's own vocabulary and moved there with the Git engine.
 */
export type * from "../shared/workspace-kit-types.js";

/** Leaf helpers a workspace kit needs and core keeps for itself as well. */
export { assistantAnchorForBranch } from "./session-entries.js";
export { readBoundedImagePreview } from "./image-preview.js";
export { gitExecutable, findExecutable, type FindExecutableOptions } from "./shell-environment.js";
/** Starting a command the way the platform needs: `.cmd` shims through `cmd.exe`, process trees ended whole. */
export { commandInvocation, killProcessTree, type CommandInvocation, type CommandInvocationOptions } from "./platform-process.js";
export { assertAllowedCloneSource } from "./clone-source.js";
// `~/.tau`, or Tau Dev's `~/.tau-dev`: where a kit reads the user's own settings (API 1.34.0).
export { tauHomeDir } from "./app-identity.js";

/** For a backend that drives a CLI: the newest npm release, the package manager's update command, version order. */
export { homebrewLatestVersion, npmLatestVersion, packageInstallCommand, packageUpdateCommand, type HomebrewKind, type NpmLatestVersionOptions } from "./cli-versions.js";
// How a CLI is installed and what keeps it current (maintenance, programKey).
export { cliCommandText, cliMaintenance, detectCliInstall, executableFingerprint, type CliCommand, type CliInstall, type CliInstallMethod, type CliMaintenanceOptions, type CliPackageSpec, type RuntimeToolMaintenance } from "./cli-install.js";
export { compareVersions, updateAvailable } from "../shared/runtime-version.js";
// Several setups of one program, and the versions of it a backend works with (API 1.11.0).
export { RuntimeInstanceSettings, expandHome, runtimeUpdateCommand, runtimeVersionPolicy, type RuntimeInstanceSettingsOptions } from "./runtime-instance-settings.js";
export {
  DEFAULT_INSTANCE_ID,
  formatEnvironment,
  instanceIdFromName,
  instanceIdProblem,
  isRuntimeInstanceOf,
  parseEnvironment,
  runtimeDriver,
  runtimeInstanceId,
  runtimeInstanceKind,
  splitArguments,
  type RuntimeInstanceConfig,
} from "../shared/runtime-instances.js";
export { parseVersionPolicy, satisfiesVersionRange, versionCompatibility, type VersionPolicy } from "../shared/version-policy.js";
/** For a backend without a readable journal: its tool cards kept across restarts (API 1.12.0). */
export { TurnActivityStore, type TurnActivityStoreOptions } from "./turn-activity-store.js";
/** An MCP elicitation form asked field by field on the dialog surface (API 1.12.0). */
export { askElicitation, elicitationFieldTitle, elicitationFields, type ElicitationField, type ElicitationFormInput, type ElicitationOutcome, type ElicitationValue } from "./elicitation-form.js";
// A turn's tokens per model, and how core prices them (API 1.12.0).
export {
  addTally,
  appendUsageTurn,
  emptyTally,
  legacyUsageTurn,
  mergeTallies,
  readUsageTurns,
  unpricedUsage,
  type PricedUsage,
  type UsageTally,
  type UsageTurn,
} from "./usage-pricing.js";
/** Signing in from the window: the commands and event around a kit's own flows, and the command line a terminal runs (API 1.12.0). */
export { registerSignIn, type SignInFlowContext, type SignInOptions, type SignInShown } from "./sign-in-flows.js";
export {
  THREAD_TEXT_CHARS,
  THREAD_TEXTS_COMMAND,
  threadTextsDelta,
  type StoredThreadText,
  type ThreadText,
  type ThreadTextMessage,
  type ThreadTextsAnswer,
  type ThreadTextsRequest,
} from "./thread-texts.js";
export { SIGN_IN_COMMANDS, SIGN_IN_EVENT, commandLine, shellQuote, signInActive } from "../shared/sign-in.js";
export type * from "../shared/sign-in.js";

/** OS-held locks release on process exit, including crashes. */
export type { ProcessLock } from "./process-lock.js";
export async function tryProcessLock(path: string, owner: import("./process-lock.js").LockOwner): Promise<import("./process-lock.js").ProcessLock | undefined> {
  // Loading this API must not import node:net into workers that lack network permission.
  const { tryLock } = await import("./process-lock.js");
  return tryLock(path, owner);
}

export { findProjectForSession } from "../shared/session-project.js";
