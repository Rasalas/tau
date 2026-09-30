import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TOOLS, type DeviceSettings, type ToolState } from "./protocol.js";
import { run, type Run } from "./process.js";
export class Toolchain {
  private installs = new Map<string, Promise<void>>();
  constructor(readonly directory: string, private execute: Run = run) {}
  root(tool: "hub" | "agent"): string { const spec = TOOLS[tool]; return join(this.directory, "tools", spec.package, spec.version); }
  entry(tool: "hub" | "agent"): string { return join(this.root(tool), "node_modules", TOOLS[tool].package, TOOLS[tool].entry); }
  async installed(tool: "hub" | "agent"): Promise<boolean> {
    try { await access(this.entry(tool)); return (await readFile(join(this.root(tool), ".complete"), "utf8")).trim() === TOOLS[tool].version; } catch { return false; }
  }
  async states(checkLatest = false): Promise<ToolState[]> {
    return Promise.all((["hub", "agent"] as const).map(async (tool) => {
      const spec = TOOLS[tool];
      const state: ToolState = { tool, package: spec.package, required: spec.version, installed: await this.installed(tool) };
      if (checkLatest) {
        const response = await fetch(`https://registry.npmjs.org/${spec.package}/latest`, { signal: AbortSignal.timeout(15_000) });
        if (!response.ok) throw new Error(`Cannot check ${spec.package} versions.`);
        const body = await response.json() as { version: string };
        state.latest = body.version;
      }
      return state;
    }));
  }
  install(tool: "hub" | "agent", settings: DeviceSettings): Promise<void> {
    const active = this.installs.get(tool);
    if (active) return active;
    const work = this.performInstall(tool, settings).finally(() => this.installs.delete(tool));
    this.installs.set(tool, work);
    return work;
  }
  private async performInstall(tool: "hub" | "agent", settings: DeviceSettings): Promise<void> {
    if (await this.installed(tool)) return;
    const spec = TOOLS[tool], parent = join(this.directory, "tools", spec.package);
    await mkdir(parent, { recursive: true });
    const staging = await mkdtemp(join(parent, ".install-"));
    try {
      await this.execute(settings.npm, ["install", "--prefix", staging, "--no-audit", "--no-fund", `${spec.package}@${spec.version}`], { timeout: 300_000 });
      await access(join(staging, "node_modules", spec.package, spec.entry));
      await writeFile(join(staging, ".complete"), spec.version + "\n");
      // A failed interrupted installation must never look ready.
      await rm(this.root(tool), { recursive: true, force: true });
      await rename(staging, this.root(tool));
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}
