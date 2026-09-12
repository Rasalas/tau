import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TauConfig } from "../shared/contracts.js";

export interface HostConfigPaths {
  globalFilePath?: string;
  projectFilePath?: (cwd: string) => string;
  piAgentDir?: string;
}

export function defaultGlobalConfigPath(home = homedir()): string {
  return process.env.TAU_CONFIG_FILE || join(home, ".tau", "config.json");
}

export function defaultProjectConfigPath(cwd: string): string {
  return join(cwd, ".tau", "config.json");
}

interface PiRawSettings {
  defaultProvider?: string;
  defaultModel?: string;
  defaultThinkingLevel?: string;
  theme?: string;
  temperature?: number;
  compaction?: TauConfig["compaction"];
  retry?: TauConfig["retry"];
  steeringMode?: TauConfig["steeringMode"];
  followUpMode?: TauConfig["followUpMode"];
  defaultTools?: string[];
  shellPath?: string;
  shellCommandPrefix?: string;
  npmCommand?: string[];
  quietStartup?: boolean;
  defaultProjectTrust?: TauConfig["defaultProjectTrust"];
}

function piSettingsToTauConfig(pi?: PiRawSettings): Partial<TauConfig> {
  if (!pi) return {};
  const config: Partial<TauConfig> = {};
  if (pi.defaultProvider && pi.defaultModel) {
    config.models = { default: `${pi.defaultProvider}/${pi.defaultModel}` };
  } else if (pi.defaultModel) {
    config.models = { default: pi.defaultModel };
  }
  if (pi.defaultThinkingLevel) {
    config.models = { ...(config.models ?? {}), thinkingLevel: pi.defaultThinkingLevel as any };
  }
  if (pi.theme) {
    config.theme = pi.theme;
  }
  if (typeof pi.temperature === "number") {
    config.temperature = pi.temperature;
  }
  if (pi.compaction && typeof pi.compaction === "object") {
    config.compaction = pi.compaction;
  }
  if (pi.retry && typeof pi.retry === "object") {
    config.retry = pi.retry;
  }
  if (pi.steeringMode) {
    config.steeringMode = pi.steeringMode;
  }
  if (pi.followUpMode) {
    config.followUpMode = pi.followUpMode;
  }
  if (Array.isArray(pi.defaultTools)) {
    config.defaultTools = pi.defaultTools;
  }
  if (typeof pi.shellPath === "string") {
    config.shellPath = pi.shellPath;
  }
  if (typeof pi.shellCommandPrefix === "string") {
    config.shellCommandPrefix = pi.shellCommandPrefix;
  }
  if (Array.isArray(pi.npmCommand)) {
    config.npmCommand = pi.npmCommand;
  }
  if (typeof pi.quietStartup === "boolean") {
    config.quietStartup = pi.quietStartup;
  }
  if (pi.defaultProjectTrust) {
    config.defaultProjectTrust = pi.defaultProjectTrust;
  }
  return config;
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
 * Seamlessly inherits baseline defaults from Pi CLI settings.json when not overridden.
 */
export class HostConfigManager {
  private readonly globalPath: string;
  private readonly projectPathResolver: (cwd: string) => string;
  private readonly piAgentDir: string;

  constructor(paths: HostConfigPaths = {}) {
    this.globalPath = paths.globalFilePath ?? defaultGlobalConfigPath();
    this.projectPathResolver = paths.projectFilePath ?? defaultProjectConfigPath;
    this.piAgentDir = paths.piAgentDir ?? getAgentDir();
  }

  async read(cwd?: string): Promise<TauConfig> {
    const globalPi = await readJson<PiRawSettings>(join(this.piAgentDir, "settings.json"));
    const projectPi = cwd ? await readJson<PiRawSettings>(join(cwd, ".pi", "settings.json")) : undefined;
    const piBase = this.merge(piSettingsToTauConfig(globalPi), piSettingsToTauConfig(projectPi));

    const globalConfig = (await readJson<TauConfig>(this.globalPath)) ?? {};
    const base = this.merge(piBase, globalConfig);
    if (!cwd) return base;
    const projectPath = this.projectPathResolver(cwd);
    const projectConfig = (await readJson<TauConfig>(projectPath)) ?? {};
    return this.merge(base, projectConfig);
  }

  readSync(cwd?: string): TauConfig {
    const globalPi = readJsonSync<PiRawSettings>(join(this.piAgentDir, "settings.json"));
    const projectPi = cwd ? readJsonSync<PiRawSettings>(join(cwd, ".pi", "settings.json")) : undefined;
    const piBase = this.merge(piSettingsToTauConfig(globalPi), piSettingsToTauConfig(projectPi));

    const globalConfig = readJsonSync<TauConfig>(this.globalPath) ?? {};
    const base = this.merge(piBase, globalConfig);
    if (!cwd) return base;
    const projectPath = this.projectPathResolver(cwd);
    const projectConfig = readJsonSync<TauConfig>(projectPath) ?? {};
    return this.merge(base, projectConfig);
  }

  async update(patch: Partial<TauConfig>, scope: "global" | "project" = "global", cwd?: string): Promise<TauConfig> {
    const targetPath = scope === "project" && cwd ? this.projectPathResolver(cwd) : this.globalPath;
    const existing = (await readJson<TauConfig>(targetPath)) ?? {};
    const updated = this.merge(existing, this.sanitizePatch(patch));
    await writeJson(targetPath, updated);
    return this.read(cwd);
  }

  /**
   * Strips any key not present in TauConfig and silently drops values with wrong primitive
   * types for known fields. This is a defence-in-depth layer — the IPC decoder (`decodeConfigPatch`
   * in `ipc-input.ts`) validates and rejects bad payloads before they reach here; this ensures
   * callers that bypass the IPC path (e.g. in tests or internal code) cannot write unrecognised
   * keys to `~/.tau/config.json`.
   */
  private sanitizePatch(patch: Partial<TauConfig>): Partial<TauConfig> {
    const KNOWN_KEYS = new Set<keyof TauConfig>([
      "theme", "transcriptDetail", "showCosts", "favouriteModels", "disabledExtensions",
      "prewarm", "options", "values", "keybindings", "fontFamily", "fontSize",
      "density", "temperature", "maxTokens", "models", "compaction", "retry",
      "steeringMode", "followUpMode", "defaultTools", "shellPath",
      "shellCommandPrefix", "npmCommand", "quietStartup", "defaultProjectTrust",
    ]);
    const result: Partial<TauConfig> = {};
    for (const [key, val] of Object.entries(patch) as [keyof TauConfig, unknown][]) {
      if (!KNOWN_KEYS.has(key)) continue; // drop unknown keys
      // Basic per-field type guard to prevent wrong-typed values reaching the persisted file.
      // Strict type enforcement happens at the IPC boundary; here we silently skip.
      switch (key) {
        case "theme": case "transcriptDetail": case "fontFamily": case "density":
        case "steeringMode": case "followUpMode": case "shellPath": case "shellCommandPrefix":
        case "defaultProjectTrust":
          if (typeof val === "string") result[key] = val as never;
          break;
        case "showCosts": case "prewarm": case "quietStartup":
          if (typeof val === "boolean") result[key] = val as never;
          break;
        case "fontSize": case "temperature": case "maxTokens":
          if (typeof val === "number" && Number.isFinite(val)) result[key] = val as never;
          break;
        case "favouriteModels": case "disabledExtensions": case "defaultTools": case "npmCommand":
          if (Array.isArray(val) && (val as unknown[]).every((m) => typeof m === "string")) result[key] = val as never;
          break;
        case "options":
          if (val && typeof val === "object" && !Array.isArray(val)) result.options = val as Record<string, boolean>;
          break;
        case "values": case "keybindings":
          if (val && typeof val === "object" && !Array.isArray(val)) result[key] = val as never;
          break;
        case "models":
          if (val && typeof val === "object" && !Array.isArray(val)) result.models = val as TauConfig["models"];
          break;
        case "compaction":
          if (val && typeof val === "object" && !Array.isArray(val)) result.compaction = val as TauConfig["compaction"];
          break;
        case "retry":
          if (val && typeof val === "object" && !Array.isArray(val)) result.retry = val as TauConfig["retry"];
          break;
      }
    }
    return result;
  }

  private merge(base: TauConfig, override: Partial<TauConfig>): TauConfig {
    const result: TauConfig = {
      ...base,
      ...override,
    };
    if (base.options || override.options) {
      result.options = { ...(base.options ?? {}), ...(override.options ?? {}) };
    }
    if (base.values || override.values) {
      result.values = { ...(base.values ?? {}), ...(override.values ?? {}) };
    }
    if (base.keybindings || override.keybindings) {
      result.keybindings = { ...(base.keybindings ?? {}), ...(override.keybindings ?? {}) };
    }
    if (override.favouriteModels !== undefined || base.favouriteModels !== undefined) {
      result.favouriteModels = override.favouriteModels ?? base.favouriteModels;
    }
    if (override.disabledExtensions !== undefined || base.disabledExtensions !== undefined) {
      result.disabledExtensions = override.disabledExtensions ?? base.disabledExtensions;
    }
    if (override.models || base.models) {
      result.models = {
        ...(base.models ?? {}),
        ...(override.models ?? {}),
        presets: { ...(base.models?.presets ?? {}), ...(override.models?.presets ?? {}) },
      };
    }
    if (override.compaction || base.compaction) {
      result.compaction = { ...(base.compaction ?? {}), ...(override.compaction ?? {}) };
    }
    if (override.retry || base.retry) {
      result.retry = {
        ...(base.retry ?? {}),
        ...(override.retry ?? {}),
        ...(base.retry?.provider || override.retry?.provider ? {
          provider: {
            ...(base.retry?.provider ?? {}),
            ...(override.retry?.provider ?? {}),
          },
        } : {}),
      };
    }
    return result;
  }
}

export const defaultHostConfigManager = new HostConfigManager();
