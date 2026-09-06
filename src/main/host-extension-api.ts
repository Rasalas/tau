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
export type * from "../shared/contracts.js";
export { HostCommandError, isExpectedCommandError } from "./host-extension-errors.js";
export { buildTitleConversation, cleanThreadTitle, firstSentence, safeSessionTitle, textFromContent, visibleTitleText, type TitleMessage } from "./host-text.js";
export { prepareSkillPrompt, skillInvocationCommand, type PreparedSkillPrompt, type SkillRuntimeAdapter } from "./skill-invocation.js";
export { readPersistedJson, writePersistedJson, type PersistedJsonLogger, type PersistedJsonRead } from "./persisted-json.js";
export { clientMessageFingerprint } from "../shared/client-message-correlation.js";
export { validatePreparedPrompt } from "../shared/prepared-prompt.js";
export { isSkillName, knownSkillNames, parseSkillEnvelope, type ParsedSkillEnvelope } from "../shared/skill-envelope.js";
export type { ExtensionIsolation, ExtensionPermission } from "../shared/extension-permissions.js";
export type { WorkspaceRef } from "../shared/workspace-identity.js";
