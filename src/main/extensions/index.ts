import type { HostExtension } from "../host-extensions.js";
import { createAccessHostExtension } from "./access-host-extension.js";
import { createAgentsHostExtension } from "./agents-host-extension.js";
import { createClaudeCodeHostExtension } from "./claude-code/host-extension.js";
import { createComputerUseHostExtension } from "./computer-use-host-extension.js";
import { createKeybindingsHostExtension } from "./keybindings-host-extension.js";
import { createPackagesHostExtension } from "./packages-host-extension.js";
import { createPiUiHostExtension } from "./pi-ui-host-extension.js";
import { createPreviewHostExtension } from "./preview-host-extension.js";
import { createQuestionnaireHostExtension } from "./questionnaire-host-extension.js";
import { createReviewHostExtension } from "./review-host-extension.js";
import { createServiceTierHostExtension } from "./service-tier-host-extension.js";
import { createThreadTitlesHostExtension } from "./thread-titles-host-extension.js";
import { createWorkspaceHostExtension } from "./workspace-host-extension.js";
import { createWorktreeNamesHostExtension } from "./worktree-names-host-extension.js";

/** Host entries of the bundled kits. Safe mode starts the host with none of them. */
export function bundledHostExtensions(): HostExtension[] {
  return [
    createAccessHostExtension(),
    createWorkspaceHostExtension(),
    createReviewHostExtension(),
    createThreadTitlesHostExtension(),
    createWorktreeNamesHostExtension(),
    createServiceTierHostExtension(),
    createQuestionnaireHostExtension(),
    createComputerUseHostExtension(),
    createPreviewHostExtension(),
    createAgentsHostExtension(),
    createKeybindingsHostExtension(),
    createPiUiHostExtension(),
    createPackagesHostExtension(),
    createClaudeCodeHostExtension(),
  ];
}
