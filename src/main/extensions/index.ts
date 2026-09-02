import type { HostExtension } from "../host-extensions.js";
import { createAccessHostExtension } from "./access-host-extension.js";
import { createComputerUseHostExtension } from "./computer-use-host-extension.js";
import { createKeybindingsHostExtension } from "./keybindings-host-extension.js";
import { createPiUiHostExtension } from "./pi-ui-host-extension.js";
import { createQuestionnaireHostExtension } from "./questionnaire-host-extension.js";
import { createServiceTierHostExtension } from "./service-tier-host-extension.js";
import { createThreadTitlesHostExtension } from "./thread-titles-host-extension.js";
import { createWorkspaceHostExtension } from "./workspace-host-extension.js";

/** Host entries of the bundled kits. Safe mode starts the host with none of them. */
export function bundledHostExtensions(): HostExtension[] {
  return [
    createAccessHostExtension(),
    createWorkspaceHostExtension(),
    createThreadTitlesHostExtension(),
    createServiceTierHostExtension(),
    createQuestionnaireHostExtension(),
    createComputerUseHostExtension(),
    createKeybindingsHostExtension(),
    createPiUiHostExtension(),
  ];
}
