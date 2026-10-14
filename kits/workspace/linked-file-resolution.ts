import { stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { HostCommandError, isWorkspaceRelativePath, type HostExtensionServices } from "tau/host-extension";
import { deviceReadPaths } from "../_filesystem/device-read-paths.js";
import { readRepositoryIdentity } from "./repository-identity.js";
import { mainCheckoutOf } from "./workspace-git.js";

/** Only missing workspace-relative links may try the same file in the main checkout. */
export async function resolveLinkedFile(project: string, path: string, owner: boolean, services: Pick<HostExtensionServices, "knownWorkspacePath">): Promise<{ path: string; mainCheckoutPath?: string }> {
  const attempted = [resolve(project, path)];
  const exists = async (target: string) => {
    try { await stat(target); return true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      return false;
    }
  };
  if (await exists(attempted[0])) return { path: attempted[0] };
  const main = isWorkspaceRelativePath(path) ? await mainCheckoutOf(project) : undefined;
  if (main) {
    const identity = await readRepositoryIdentity(project);
    const folder = identity ? relative(identity.root, identity.folder) : "";
    const fallback = resolve(main, folder, path);
    let admitted = main;
    if (!owner) {
      // Derived reads need their own admitted scope and canonical-path check.
      try { admitted = await services.knownWorkspacePath(main); }
      catch { throw Object.assign(new HostCommandError("The main checkout is not an admitted workspace on this device."), { code: "forbidden" }); }
    }
    attempted.push(fallback);
    if (await exists(fallback)) {
      const target = owner ? fallback : await (await deviceReadPaths(admitted)).resolve(fallback);
      if (!target) throw Object.assign(new HostCommandError("Access to this main checkout file was denied."), { code: "forbidden" });
      return { path: target, mainCheckoutPath: main };
    }
  }
  throw Object.assign(new HostCommandError(`ENOENT: File not found. Checked ${attempted.join(" and ")}.`), { code: "ENOENT" });
}
