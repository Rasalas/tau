import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { FILES_KIT_ID, UNKNOWN_PROJECT, WORKSPACE_KIT_ID } from "./protocol.js";

function namedProject(input: unknown): boolean {
  const workspace = input && typeof input === "object" ? (input as { workspace?: unknown }).workspace : undefined;
  return typeof workspace === "string" && workspace.length > 0;
}

/**
 * Files Kit's host half. Workspace Kit reads and writes the project's files
 * and checks every path; this half reaches those commands with its own host
 * context, which Workspace grants by name, so renderer input cannot widen it.
 * A write must name its project: without one Workspace would use the host's.
 * Reads without one keep the host's project, as older and remote callers expect.
 */
export function createFilesHostExtension(): WorkerHostExtension {
  return {
    id: FILES_KIT_ID,
    name: "Files",
    activate(context: WorkerHostExtensionContext) {
      const forward = (command: string, target: string, refusal: string, access?: "read") =>
        context.registerCommand(command, async (input) => {
          if (!access && !namedProject(input)) throw new Error(`${refusal}${UNKNOWN_PROJECT}`);
          try {
            return await context.invokeHostExtension(WORKSPACE_KIT_ID, target, input);
          } catch (error) {
            if (error instanceof Error && /not a known Tau project/u.test(error.message)) {
              throw new Error(`${refusal}This file's project is not open in Tau any more.`, { cause: error });
            }
            throw error;
          }
        }, access ? { access } : undefined);
      forward("read", "read-file", "", "read");
      forward("stat", "file-stat", "", "read");
      forward("write", "write-file", "Not saved: ");
    },
  };
}

export default createFilesHostExtension;
