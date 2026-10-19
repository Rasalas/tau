import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { HostExtensionContext } from "tau/host-extension";
import { CUSTOMIZATION_PROJECT_NAME, type CustomizationProject } from "./protocol.js";

/** The global extension folder as the project's path: resolved once it exists, so it matches what the host admits. */
async function projectPath(directory: string): Promise<string> {
  return realpath(directory).catch(() => directory);
}

/** How many packages lie in the folder: subfolders with a manifest, the way the scan reads them. */
async function packageCount(directory: string): Promise<number> {
  const names = await readdir(directory).catch(() => [] as string[]);
  const manifests = await Promise.all(names.filter((name) => !name.startsWith(".") && !name.startsWith("_") && name !== "node_modules")
    .map((name) => stat(join(directory, name, "tau-extension.json")).then((info) => info.isFile(), () => false)));
  return manifests.filter(Boolean).length;
}

/**
 * `customization-folder` answers the folder without creating it;
 * `customization-project` creates it if needed and admits it as a project
 * named "Tau customizations", the same project every time.
 */
export function registerCustomizeProject(context: HostExtensionContext): void {
  const { services } = context;
  // The name is held in memory, so it has to be told again after each start.
  void projectPath(services.globalExtensionsDirectory())
    .then((path) => services.rememberProjectName(path, CUSTOMIZATION_PROJECT_NAME))
    .catch((error: unknown) => services.log("packages.customize.name", error instanceof Error ? error.message : String(error)));
  context.registerCommand("customization-folder", async () => {
    const directory = await projectPath(services.globalExtensionsDirectory());
    return { directory, packages: await packageCount(directory) };
  }, { access: "read" });
  context.registerCommand("customization-project", async (): Promise<CustomizationProject> => {
    const directory = services.globalExtensionsDirectory();
    await mkdir(directory, { recursive: true });
    const path = await projectPath(directory);
    services.rememberProjectName(path, CUSTOMIZATION_PROJECT_NAME);
    return { directory: path, workspaceId: services.admitWorkspace(path).workspaceId };
  });
}
