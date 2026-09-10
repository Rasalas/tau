import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { TauConfig } from "../shared/contracts.js";

export interface HostConfigPaths {
  globalFilePath?: string;
  projectFilePath?: (cwd: string) => string;
}

export function defaultGlobalConfigPath(home = homedir()): string {
  return process.env.TAU_CONFIG_FILE || join(home, ".tau", "config.json");
}

export function defaultProjectConfigPath(cwd: string): string {
  return join(cwd, ".tau", "config.json");
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    if (!existsSync(path)) return undefined;
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function readJsonSync<T>(path: string): T | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const raw = readFileSync(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(data, null, 2), "utf8");
}

/**
 * Manages configuration as code for Tau.
 * Reads and merges global ~/.tau/config.json with optional project-level .tau/config.json.
 */
export class HostConfigManager {
  private readonly globalPath: string;
  private readonly projectPathResolver: (cwd: string) => string;

  constructor(paths: HostConfigPaths = {}) {
    this.globalPath = paths.globalFilePath ?? defaultGlobalConfigPath();
    this.projectPathResolver = paths.projectFilePath ?? defaultProjectConfigPath;
  }

  async read(cwd?: string): Promise<TauConfig> {
    const globalConfig = (await readJson<TauConfig>(this.globalPath)) ?? {};
    if (!cwd) return globalConfig;
    const projectPath = this.projectPathResolver(cwd);
    const projectConfig = (await readJson<TauConfig>(projectPath)) ?? {};
    return this.merge(globalConfig, projectConfig);
  }

  readSync(cwd?: string): TauConfig {
    const globalConfig = readJsonSync<TauConfig>(this.globalPath) ?? {};
    if (!cwd) return globalConfig;
    const projectPath = this.projectPathResolver(cwd);
    const projectConfig = readJsonSync<TauConfig>(projectPath) ?? {};
    return this.merge(globalConfig, projectConfig);
  }

  async update(patch: Partial<TauConfig>, scope: "global" | "project" = "global", cwd?: string): Promise<TauConfig> {
    const targetPath = scope === "project" && cwd ? this.projectPathResolver(cwd) : this.globalPath;
    const existing = (await readJson<TauConfig>(targetPath)) ?? {};
    const updated = this.merge(existing, patch);
    await writeJson(targetPath, updated);
    return this.read(cwd);
  }

  private merge(base: TauConfig, override: Partial<TauConfig>): TauConfig {
    return {
      ...base,
      ...override,
      options: { ...(base.options ?? {}), ...(override.options ?? {}) },
      values: { ...(base.values ?? {}), ...(override.values ?? {}) },
      keybindings: { ...(base.keybindings ?? {}), ...(override.keybindings ?? {}) },
      favouriteModels: override.favouriteModels ?? base.favouriteModels,
      disabledExtensions: override.disabledExtensions ?? base.disabledExtensions,
    };
  }
}

export const defaultHostConfigManager = new HostConfigManager();
