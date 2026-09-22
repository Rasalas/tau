import type { UiRuntimeBackend } from "../shared/contracts";
import { updateAvailable } from "../shared/runtime-version";

/** What to tell the user when a runtime's program has a newer release; undefined when it is current or unknown. */
export function runtimeUpdate(backend: UiRuntimeBackend | undefined): { text: string; command?: string } | undefined {
  const version = backend?.version;
  if (!backend || !updateAvailable(version)) return undefined;
  return { text: `${backend.label} ${version.latest} is out; ${version.installed} is installed.`, ...(version.updateCommand ? { command: version.updateCommand } : {}) };
}
