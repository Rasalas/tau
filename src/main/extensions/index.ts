import type { HostExtension } from "../host-extensions.js";
import { loadBundledKitHostHalves, type BundledKitsOptions } from "../bundled-kits.js";
import { createAccessHostExtension } from "./access-host-extension.js";
import { createAgentsHostExtension } from "./agents-host-extension.js";
import { createClaudeCodeHostExtension } from "./claude-code/host-extension.js";
import { createComputerUseHostExtension } from "./computer-use-host-extension.js";
import { createKeybindingsHostExtension } from "../keybindings-host-extension.js";
import { createPiUiHostExtension } from "./pi-ui-host-extension.js";
import { createPreviewHostExtension } from "./preview-host-extension.js";
import { createQuestionnaireHostExtension } from "./questionnaire-host-extension.js";
import { createReviewHostExtension } from "./review-host-extension.js";
import { createServiceTierHostExtension } from "./service-tier-host-extension.js";
import { createWorkspaceHostExtension } from "./workspace-host-extension.js";

/**
 * Every host half Tau ships, as the host activates them: the kits that already
 * live under `kits/` are compiled and imported like packages, the rest are
 * still constructed here. Ticket by ticket this list shrinks to nothing.
 */
export function shippedHostExtensions(
  options: BundledKitsOptions,
  log: (label: string, detail: string) => void,
): () => Promise<HostExtension[]> {
  return async () => {
    const loaded = await loadBundledKitHostHalves(options);
    for (const failure of loaded.errors) log("host-extension.kit.failed", `${failure.path}: ${failure.message}`);
    return [...bundledHostExtensions(), ...loaded.extensions];
  };
}

/** Host entries of the kits still built in the host. Safe mode starts with none of them. */
export function bundledHostExtensions(): HostExtension[] {
  return [
    createAccessHostExtension(),
    createWorkspaceHostExtension(),
    createReviewHostExtension(),
    createServiceTierHostExtension(),
    createQuestionnaireHostExtension(),
    createComputerUseHostExtension(),
    createPreviewHostExtension(),
    createAgentsHostExtension(),
    createKeybindingsHostExtension(),
    createPiUiHostExtension(),
    createClaudeCodeHostExtension(),
  ];
}
