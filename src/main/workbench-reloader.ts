import type { WorkbenchBuildResult } from "../shared/contracts.js";
import { missingWorkbenchBuildOutput, resolveTauSourceRoot, writeWorkbenchSourceRoot } from "./workbench-source.js";

interface RelaunchApp {
  relaunch(): void;
  quit(): void;
}

interface ManagedSource {
  existing(): Promise<string | undefined>;
  ensure(): Promise<string>;
}

interface WorkbenchReloaderOptions {
  packaged: boolean;
  appPath: string;
  userData: string;
  app: RelaunchApp;
  managedSource?: ManagedSource;
  rebuild(root: string, options: { onOutput?(line: string): void }): Promise<WorkbenchBuildResult>;
}

const INSTALLED_EXTENSION_RELOAD: WorkbenchBuildResult = {
  ok: true,
  durationMs: 0,
  mainChanged: false,
  runtimeChanged: false,
  output: "No Tau source checkout is open; reloading extensions only.",
};

/** Owns source selection, build activation, and the restart that applies it. */
export class WorkbenchReloader {
  constructor(private readonly options: WorkbenchReloaderOptions) {}

  async rebuild(activeWorkspace: string, hooks: { onOutput?(line: string): void } = {}): Promise<WorkbenchBuildResult> {
    if (!this.options.packaged) return this.options.rebuild(this.options.appPath, hooks);

    const openSource = await resolveTauSourceRoot(activeWorkspace);
    const sourceRoot = openSource ?? await this.options.managedSource?.existing() ?? await this.options.managedSource?.ensure();
    if (!sourceRoot) return INSTALLED_EXTENSION_RELOAD;

    const result = await this.options.rebuild(sourceRoot, hooks);
    if (!result.ok) return result;

    const missing = await missingWorkbenchBuildOutput(sourceRoot);
    if (missing) {
      return {
        ...result,
        ok: false,
        output: `${result.output}\nTau's build did not produce the required build output: ${missing}`.trim(),
      };
    }

    await writeWorkbenchSourceRoot(this.options.userData, sourceRoot);
    // The first switch from app.asar to checkout code always needs a relaunch,
    // even when the checkout's main bundle did not change during this build.
    return { ...result, mainChanged: true };
  }

  relaunch(): void {
    this.options.app.relaunch();
    this.options.app.quit();
  }
}
