import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { TauConfig } from "../shared/contracts.js";
import { isUpdateChannel, type UpdateChannel } from "../shared/app-version.js";
import { isQuitConfirmation } from "../shared/window-shell.js";
import { PI_OWNED_CONFIG_KEYS, isPiOwnedSetting, withoutPiOwned, withoutSetting, type ConfigLayers } from "../shared/config-layers.js";

export interface HostConfigPaths {
  globalFilePath?: string;
  projectFilePath?: (cwd: string) => string;
  piAgentDir?: string;
  /** Pi's own global settings file; defaults to `<piAgentDir>/settings.json`. */
  piGlobalFilePath?: string;
  /** Pi's own project settings file; defaults to `<cwd>/.pi/settings.json`. */
  piProjectFilePath?: (cwd: string) => string;
}

/**
 * Tau mirrors the keys Pi owns (`PI_OWNED_CONFIG_KEYS`) so a client can read
 * what the user configured, but never stores them in `~/.tau/config.json`: a
 * value written there would be accepted, persisted and never applied.
 * `HostConfigManager.update` routes them to Pi's file, which both Pi and Tau read.
 */
const PI_OWNED = new Set<string>(PI_OWNED_CONFIG_KEYS);

export function defaultGlobalConfigPath(home = homedir()): string {
  return process.env.TAU_CONFIG_FILE || join(home, ".tau", "config.json");
}

export function defaultProjectConfigPath(cwd: string): string {
  return join(cwd, ".tau", "config.json");
}

export function defaultPiProjectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json");
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

/**
 * The reverse of `piSettingsToTauConfig`, for the keys Pi owns. A Tau patch is
 * spelled in Tau's vocabulary (`models.default` is `"provider/modelId"`); Pi's
 * file wants `defaultProvider` and `defaultModel` apart.
 */
function tauConfigToPiSettings(patch: Partial<TauConfig>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const model = patch.models?.default;
  if (model) {
    const slash = model.indexOf("/");
    if (slash > 0) {
      out.defaultProvider = model.slice(0, slash);
      out.defaultModel = model.slice(slash + 1);
    } else {
      out.defaultModel = model;
    }
  }
  if (patch.models?.thinkingLevel !== undefined) out.defaultThinkingLevel = patch.models.thinkingLevel;
  if (patch.compaction !== undefined) out.compaction = patch.compaction;
  if (patch.retry !== undefined) out.retry = patch.retry;
  if (patch.steeringMode !== undefined) out.steeringMode = patch.steeringMode;
  if (patch.followUpMode !== undefined) out.followUpMode = patch.followUpMode;
  if (patch.defaultTools !== undefined) out.defaultTools = patch.defaultTools;
  if (patch.shellPath !== undefined) out.shellPath = patch.shellPath;
  if (patch.shellCommandPrefix !== undefined) out.shellCommandPrefix = patch.shellCommandPrefix;
  if (patch.npmCommand !== undefined) out.npmCommand = patch.npmCommand;
  if (patch.quietStartup !== undefined) out.quietStartup = patch.quietStartup;
  if (patch.defaultProjectTrust !== undefined) out.defaultProjectTrust = patch.defaultProjectTrust;
  return out;
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
  private readonly piGlobalPath: string;
  private readonly piProjectPathResolver: (cwd: string) => string;

  constructor(paths: HostConfigPaths = {}) {
    this.globalPath = paths.globalFilePath ?? defaultGlobalConfigPath();
    this.projectPathResolver = paths.projectFilePath ?? defaultProjectConfigPath;
    this.piAgentDir = paths.piAgentDir ?? getAgentDir();
    this.piGlobalPath = paths.piGlobalFilePath ?? join(this.piAgentDir, "settings.json");
    this.piProjectPathResolver = paths.piProjectFilePath ?? defaultPiProjectSettingsPath;
  }

  async read(cwd?: string): Promise<TauConfig> {
    const globalPi = await readJson<PiRawSettings>(this.piGlobalPath);
    const projectPi = cwd ? await readJson<PiRawSettings>(this.piProjectPathResolver(cwd)) : undefined;
    const piBase = this.merge(piSettingsToTauConfig(globalPi), piSettingsToTauConfig(projectPi));

    const globalConfig = (await readJson<TauConfig>(this.globalPath)) ?? {};
    const base = this.merge(piBase, globalConfig);
    if (!cwd) return this.piWins(base, piBase);
    const projectPath = this.projectPathResolver(cwd);
    const projectConfig = (await readJson<TauConfig>(projectPath)) ?? {};
    return this.piWins(this.merge(base, projectConfig), piBase);
  }

  readSync(cwd?: string): TauConfig {
    const globalPi = readJsonSync<PiRawSettings>(this.piGlobalPath);
    const projectPi = cwd ? readJsonSync<PiRawSettings>(this.piProjectPathResolver(cwd)) : undefined;
    const piBase = this.merge(piSettingsToTauConfig(globalPi), piSettingsToTauConfig(projectPi));

    const globalConfig = readJsonSync<TauConfig>(this.globalPath) ?? {};
    const base = this.merge(piBase, globalConfig);
    if (!cwd) return this.piWins(base, piBase);
    const projectPath = this.projectPathResolver(cwd);
    const projectConfig = readJsonSync<TauConfig>(projectPath) ?? {};
    return this.piWins(this.merge(base, projectConfig), piBase);
  }

  /**
   * Pi's own file decides for the keys Pi owns. `~/.tau/config.json` may still
   * hold one from a hand edit made before Tau stopped accepting them; letting it
   * win would show a value neither Pi nor Tau applies.
   */
  private piWins(config: TauConfig, piBase: TauConfig): TauConfig {
    const result = { ...config };
    for (const key of PI_OWNED_CONFIG_KEYS) {
      if (piBase[key] !== undefined) (result as Record<string, unknown>)[key] = piBase[key];
      else delete (result as Record<string, unknown>)[key];
    }
    return result;
  }

  async update(patch: Partial<TauConfig>, scope: "global" | "project" = "global", cwd?: string): Promise<TauConfig> {
    const tauPatch: Partial<TauConfig> = {};
    const piPatch: Partial<TauConfig> = {};
    for (const [key, value] of Object.entries(patch) as [keyof TauConfig, unknown][]) {
      if (value === undefined) continue;
      if (PI_OWNED.has(key)) (piPatch as Record<string, unknown>)[key] = value;
      else (tauPatch as Record<string, unknown>)[key] = value;
    }

    if (Object.keys(tauPatch).length > 0) {
      const targetPath = scope === "project" && cwd ? this.projectPathResolver(cwd) : this.globalPath;
      const existing = (await readJson<TauConfig>(targetPath)) ?? {};
      await writeJson(targetPath, this.merge(existing, this.sanitizePatch(tauPatch)));
    }
    if (Object.keys(piPatch).length > 0) await this.writePiSettings(piPatch, scope, cwd);
    return this.read(cwd);
  }

  /**
   * The host and project files as they are, without Pi's keys: what the
   * Settings levels show a value's origin from. Defaults are the client's.
   */
  async readLayers(cwd?: string): Promise<ConfigLayers> {
    const host = withoutPiOwned((await readJson<TauConfig>(this.globalPath)) ?? {});
    if (!cwd) return { host };
    const project = withoutPiOwned((await readJson<TauConfig>(this.projectPathResolver(cwd))) ?? {});
    return { host, project, projectPath: cwd };
  }

  /**
   * Removes keys from one level so the next one down shows through again.
   * A key Pi owns is never cleared here: its levels are Pi's files.
   */
  async clear(keys: readonly string[], scope: "global" | "project" = "global", cwd?: string): Promise<ConfigLayers> {
    const targetPath = scope === "project" && cwd ? this.projectPathResolver(cwd) : this.globalPath;
    const existing = await readJson<TauConfig>(targetPath);
    if (existing) {
      const next = keys.filter((key) => !isPiOwnedSetting(key)).reduce(withoutSetting, existing);
      if (JSON.stringify(next) !== JSON.stringify(existing)) await writeJson(targetPath, next);
    }
    return this.readLayers(cwd);
  }

  /**
   * Writes the keys Pi owns into Pi's own settings file, merging into whatever
   * is already there so unrelated Pi settings and unknown keys survive. A
   * project write lands in `<cwd>/.pi/settings.json`, exactly where Pi looks.
   */
  private async writePiSettings(piPatch: Partial<TauConfig>, scope: "global" | "project", cwd?: string): Promise<void> {
    const targetPath = scope === "project" && cwd ? this.piProjectPathResolver(cwd) : this.piGlobalPath;
    const existing = (await readJson<Record<string, unknown>>(targetPath)) ?? {};
    await writeJson(targetPath, { ...existing, ...tauConfigToPiSettings(piPatch) });
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
      "temperature", "maxTokens", "vimMode", "hostBackground", "threads", "updates", "confirm",
    ]);
    const result: Partial<TauConfig> = {};
    for (const [key, val] of Object.entries(patch) as [keyof TauConfig, unknown][]) {
      if (!KNOWN_KEYS.has(key)) continue; // drop unknown keys
      // Basic per-field type guard to prevent wrong-typed values reaching the persisted file.
      // Strict type enforcement happens at the IPC boundary; here we silently skip.
      // Pi-owned keys never arrive here — `update` routes them to Pi's own file.
      switch (key) {
        case "theme": case "transcriptDetail": case "fontFamily":
        case "steeringMode": case "followUpMode": case "shellPath": case "shellCommandPrefix":
        case "defaultProjectTrust":
          if (typeof val === "string") result[key] = val as never;
          break;
        case "showCosts": case "prewarm": case "quietStartup": case "vimMode": case "hostBackground":
          if (typeof val === "boolean") result[key] = val as never;
          break;
        case "fontSize": case "temperature": case "maxTokens":
          if (typeof val === "number" && Number.isFinite(val)) result[key] = val as never;
          break;
        case "favouriteModels": case "disabledExtensions":
          if (Array.isArray(val) && (val as unknown[]).every((m) => typeof m === "string")) result[key] = val as never;
          break;
        case "options":
          if (val && typeof val === "object" && !Array.isArray(val)) result.options = val as Record<string, boolean>;
          break;
        case "values": case "keybindings":
          if (val && typeof val === "object" && !Array.isArray(val)) result[key] = val as never;
          break;
        case "threads":
          if (val && typeof val === "object" && typeof (val as { continueAfterRestart?: unknown }).continueAfterRestart === "boolean") {
            result.threads = { continueAfterRestart: (val as { continueAfterRestart: boolean }).continueAfterRestart };
          }
          break;
        case "updates":
          if (val && typeof val === "object" && isUpdateChannel((val as { channel?: unknown }).channel)) {
            result.updates = { channel: (val as { channel: UpdateChannel }).channel };
          }
          break;
        case "confirm":
          if (val && typeof val === "object") {
            const { quit, quitWhileRunning } = val as { quit?: unknown; quitWhileRunning?: unknown };
            const confirm = {
              ...(isQuitConfirmation(quit) ? { quit } : {}),
              ...(typeof quitWhileRunning === "boolean" ? { quitWhileRunning } : {}),
            };
            if (Object.keys(confirm).length > 0) result.confirm = confirm;
          }
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
    if (base.extensions || override.extensions) {
      result.extensions = { ...(base.extensions ?? {}), ...(override.extensions ?? {}) };
    }
    if (base.options || override.options) {
      result.options = { ...(base.options ?? {}), ...(override.options ?? {}) };
    }
    if (base.values || override.values) {
      result.values = { ...(base.values ?? {}), ...(override.values ?? {}) };
    }
    if (base.keybindings || override.keybindings) {
      result.keybindings = { ...(base.keybindings ?? {}), ...(override.keybindings ?? {}) };
    }
    if (base.threads || override.threads) {
      result.threads = { ...(base.threads ?? {}), ...(override.threads ?? {}) };
    }
    if (base.updates || override.updates) {
      result.updates = { ...(base.updates ?? {}), ...(override.updates ?? {}) };
    }
    if (base.confirm || override.confirm) {
      result.confirm = { ...(base.confirm ?? {}), ...(override.confirm ?? {}) };
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
