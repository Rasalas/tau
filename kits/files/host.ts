import type { WorkerHostExtension, WorkerHostExtensionContext } from "tau/host";
import { FILES_KIT_ID, UNKNOWN_PROJECT, WORKSPACE_KIT_ID } from "./protocol.js";
import { createPreviewReader } from "./preview-host.js";

function namedProject(input: unknown): boolean {
  const workspace = input && typeof input === "object" ? (input as { workspace?: unknown }).workspace : undefined;
  return typeof workspace === "string" && workspace.length > 0;
}

/**
 * Files Kit's host half. Workspace Kit reads and writes the project's files
 * and checks every path; this half reaches those commands with its own host
 * context, which Workspace grants by name, so renderer input cannot widen it.
 * A write must name its project: without one Workspace would use the host's.
 * Legacy text reads without one keep the host's project. Passive previews
 * require an admitted project and use their own bounded, disposable worker.
 */
export function createFilesHostExtension(): WorkerHostExtension {
  return {
    id: FILES_KIT_ID,
    name: "Files",
    activate(context: WorkerHostExtensionContext) {
      context.registerMachineRouting();
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
      const previews = createPreviewReader();
      context.registerCommand("notebook", async (input) => {
        if (!namedProject(input)) throw new Error(UNKNOWN_PROJECT);
        const fields = input as { workspace: string; relPath?: unknown };
        if (typeof fields.relPath !== "string" || fields.relPath.length > 4096) throw new Error("Choose a notebook.");
        return previews.notebook(await context.services.knownWorkspacePath(fields.workspace), fields.relPath);
      }, { access: "read" });
      context.registerCommand("preview", async (input) => {
        if (!namedProject(input)) throw new Error(UNKNOWN_PROJECT);
        const fields = input as { workspace: string; relPath?: unknown; table?: unknown };
        if (typeof fields.relPath !== "string" || fields.relPath.length > 4096) throw new Error("Choose a workspace file.");
        if (fields.table !== undefined && (typeof fields.table !== "string" || fields.table.length > 1024)) throw new Error("Choose a table from this database.");
        const project = await context.services.knownWorkspacePath(fields.workspace);
        return previews.read(project, fields.relPath, fields.table as string | undefined);
      }, { access: "read" });
      return () => previews.dispose();
    },
  };
}

export default createFilesHostExtension;
