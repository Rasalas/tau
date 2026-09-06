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
export type * from "./runtime-types.js";
export type * from "./runtime-adapters.js";
export type * from "./pi-kit-extensions.js";
export type * from "../shared/contracts.js";
export { HostCommandError, isExpectedCommandError } from "./host-extension-errors.js";
export { buildTitleConversation, cleanThreadTitle, firstSentence, safeSessionTitle, textFromContent, visibleTitleText, type TitleMessage } from "./host-text.js";
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
export { clientMessageFingerprint } from "../shared/client-message-correlation.js";
export { validatePreparedPrompt } from "../shared/prepared-prompt.js";
export { isSkillName, knownSkillNames, parseSkillEnvelope, type ParsedSkillEnvelope } from "../shared/skill-envelope.js";
export type { ExtensionIsolation, ExtensionPermission } from "../shared/extension-permissions.js";
export type { PiShortcut, PiUserKeybindings } from "../shared/keybindings-protocol.js";
export { isWorkspaceRelativePath, namesWorkspace, type WorkspaceRef } from "../shared/workspace-identity.js";
export type { HostActionResult } from "../shared/host-protocol.js";

/**
 * The workspace vocabulary: changed files, diffs, worktrees and turn
 * checkpoints. Core speaks it too (the stage renders these shapes), so it
 * stays in `src/shared` and is published from here rather than owned by a kit.
 */
export type * from "../shared/workspace-kit-types.js";
export type * from "../shared/turn-checkpoint-types.js";

/**
 * Git, workspace leases and turn-checkpoint storage. Tau's own Pi extension
 * (`.pi/extensions/tau-session-bridge.ts`) reads these modules under jiti,
 * where no `tau/` specifier resolves, so they stay in core and are published
 * here — like `host-text.js`, and for the same reason (ADR 0014). Ticket 09
 * splits the bridge and is the moment to move them.
 */
export * as workspaceGit from "./workspace-git.js";
export { GitCoordinator, type GitCoordinatorMetrics, type GitCoordinatorOptions, type GitRefreshKind, type GitRefreshState, type GitRefreshStatus } from "./git-coordinator.js";
export { listLiveWorkspaceLeaseSessions, WorkspaceCheckpointLeaseManager, type WorkspaceCheckpointLease, type WorkspaceCheckpointLeaseManagerOptions, type WorkspaceCheckpointLeaseOptions, type WorkspaceLeaseMetadata, type WorkspaceLeaseState } from "./workspace-checkpoint-lease.js";
export { createWorkspaceKitCheckpointFeature, createWorkspaceKitCheckpointMaintenance, type WorkspaceKitCheckpointFeature, type WorkspaceKitCheckpointMaintenance, type WorkspaceKitLiveCheckpointSession } from "./workspace-kit-checkpoints.js";
export { assistantAnchorForMessage } from "./pi-turn-checkpoint-extension.js";
export {
  checkpointsForBranch,
  cloneTurnCheckpoint,
  turnCheckpointsFromEntries,
  turnRestoreBackupsFromEntries,
  turnRestoreTransactionsFromEntries,
  turnSnapshotRef,
  TURN_CHECKPOINT_CUSTOM_TYPE,
  TURN_RESTORE_BACKUP_CUSTOM_TYPE,
  TURN_RESTORE_TRANSACTION_CUSTOM_TYPE,
} from "../shared/turn-checkpoint-codec.js";
export { readBoundedFileContent, MAX_FILE_CONTENT_BYTES } from "./file-content.js";
export { gitExecutable, findExecutable } from "./shell-environment.js";
export { assertAllowedCloneSource } from "./clone-source.js";
