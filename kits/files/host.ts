import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { FILES_KIT_ID, WORKSPACE_KIT_ID } from "./protocol.js";

/**
 * Files Kit's host half. Workspace Kit reads and writes the project's files
 * and checks every path; this half reaches those commands with its own host
 * context, which Workspace grants by name, so renderer input cannot widen it.
 */
export function createFilesHostExtension(): WorkerHostExtension {
  return {
    id: FILES_KIT_ID,
    name: "Files",
    activate(context: WorkerHostExtensionContext) {
      const forward = (command: string, target: string, access?: "read") =>
        context.registerCommand(command, (input) => context.invokeHostExtension(WORKSPACE_KIT_ID, target, input), access ? { access } : undefined);
      forward("read", "read-file", "read");
      forward("stat", "file-stat", "read");
      forward("write", "write-file");
    },
  };
}

export default createFilesHostExtension;
