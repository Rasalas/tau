import { cp, mkdir, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveTauSourceRoot } from "./workbench-source.js";

interface ManagedWorkbenchSourceOptions {
  userData: string;
  version: string;
  seedDirectory: string;
  installedModulesDirectory: string;
  electronTypesDirectory: string;
  typescriptDirectory: string;
}

async function linkDirectoryEntries(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const target = join(source, entry.name);
    const link = join(destination, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      await linkDirectoryEntries(target, link);
      continue;
    }
    try { await symlink(target, link, process.platform === "win32" && entry.isDirectory() ? "junction" : undefined); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
}

/** Creates the editable, versioned source tree used by an installed Tau. */
export class ManagedWorkbenchSource {
  readonly root: string;

  constructor(private readonly options: ManagedWorkbenchSourceOptions) {
    this.root = join(options.userData, "workbench-source", options.version);
  }

  async existing(): Promise<string | undefined> {
    return resolveTauSourceRoot(this.root);
  }

  async ensure(): Promise<string> {
    const existing = await this.existing();
    if (existing) return existing;

    const temporary = `${this.root}.${process.pid}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(join(this.root, ".."), { recursive: true });
    await cp(this.options.seedDirectory, temporary, { recursive: true, errorOnExist: true });
    await mkdir(join(temporary, "node_modules"), { recursive: true });
    await linkDirectoryEntries(this.options.installedModulesDirectory, join(temporary, "node_modules"));
    await rm(join(temporary, "node_modules", "electron"), { recursive: true, force: true });
    await cp(this.options.electronTypesDirectory, join(temporary, "node_modules", "electron"), { recursive: true });
    await rm(join(temporary, "node_modules", "typescript"), { recursive: true, force: true });
    await symlink(this.options.typescriptDirectory, join(temporary, "node_modules", "typescript"), process.platform === "win32" ? "junction" : undefined);
    await writeFile(join(temporary, ".gitignore"), "dist/\ndist-electron/\ndist-kits/\nnode_modules/\nreports/\n");
    await writeFile(join(temporary, ".tau-source.json"), `${JSON.stringify({ version: 1, tauVersion: this.options.version }, null, 2)}\n`);
    await rename(temporary, this.root);
    return (await resolveTauSourceRoot(this.root))!;
  }
}
