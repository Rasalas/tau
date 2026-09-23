import type { UiRuntimeBackend } from "../shared/contracts";
import { updateAvailable } from "../shared/runtime-version";

export interface RuntimeUpdateNote {
  text: string;
  command?: string;
  /** Leads into `command`: "Update with", "Install it with". */
  verb: string;
  /** What a tab says about it in a word. */
  tag: string;
}

/**
 * What to tell the user about a runtime's program: a version its policy calls
 * unsafe or broken first, else a newer release; undefined when all is well or unknown.
 */
export function runtimeUpdate(backend: UiRuntimeBackend | undefined): RuntimeUpdateNote | undefined {
  const version = backend?.version;
  if (!backend || !version) return undefined;
  const compatibility = version.compatibility;
  if (compatibility && compatibility.status !== "supported") {
    const verdict = compatibility.status === "broken" ? "does not work with Tau" : "has known problems with Tau";
    const advice = compatibility.recommendedVersion ? ` ${compatibility.recommendedVersion} is recommended.` : "";
    const command = compatibility.installCommand ?? version.updateCommand;
    return {
      text: `${backend.label} ${version.installed ?? ""} ${verdict}.${advice}`.replace(/\s+/gu, " ").replace(" .", "."),
      ...(command ? { command } : {}),
      verb: compatibility.installCommand ? "Install it with" : "Update with",
      tag: compatibility.status === "broken" ? "version does not work" : "version has known problems",
    };
  }
  if (!updateAvailable(version)) return undefined;
  return { text: `${backend.label} ${version.latest} is out; ${version.installed} is installed.`, ...(version.updateCommand ? { command: version.updateCommand } : {}), verb: "Update with", tag: "update available" };
}
