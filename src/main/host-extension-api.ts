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
export type * from "../shared/contracts.js";
export { HostAuthorizationError, HostCommandError, type HostAuthorizationDetails } from "./host-extension-errors.js";
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
export { PARENT_LINK_ENTRY, parentLinkEntry } from "./session-lineage.js";
export { DEFAULT_THREAD_MODE, THREAD_MODE_ENTRY, threadModeFromEntries } from "../shared/thread-mode.js";
export { clientMessageFingerprint } from "../shared/client-message-correlation.js";
export { validatePreparedPrompt } from "../shared/prepared-prompt.js";
export { knownSkillNames, parseSkillEnvelope, type ParsedSkillEnvelope } from "../shared/skill-envelope.js";
export type { ExtensionIsolation, ExtensionPermission } from "../shared/extension-permissions.js";
export type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
export { isWorkspaceRelativePath, type WorkspaceRef } from "../shared/workspace-identity.js";
export type { HostActionResult } from "../shared/host-protocol.js";

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

/** For a backend that drives a CLI: the newest npm release, the package manager's update command, version order. */
export { npmLatestVersion, packageUpdateCommand, type NpmLatestVersionOptions } from "./cli-versions.js";
export { compareVersions, updateAvailable } from "../shared/runtime-version.js";
