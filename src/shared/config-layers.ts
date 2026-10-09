import type { TauConfig } from "./contracts.js";

/**
 * A setting is read from three levels: the built-in default, the host (this
 * machine's `~/.tau/config.json`) and the project (`<project>/.tau/config.json`).
 * The first level that sets a key wins, top-down from the project.
 */
export type ConfigLayerName = "default" | "host" | "project";

/** Which levels a setting may be written to. */
export type SettingScope = "host" | "project" | "both";

/** The two files as they are on disk, without the keys Pi owns. */
export interface ConfigLayers {
  host: TauConfig;
  project?: TauConfig;
  /** The project the project level belongs to. */
  projectPath?: string;
}

/**
 * Keys Pi reads from its own `settings.json` and applies itself. They have
 * Pi's own global and project files, so they take no part in Tau's levels.
 */
export const PI_OWNED_CONFIG_KEYS = [
  "models", "compaction", "retry", "steeringMode", "followUpMode",
  "defaultTools", "shellPath", "shellCommandPrefix", "npmCommand",
  "quietStartup", "defaultProjectTrust",
] as const satisfies readonly (keyof TauConfig)[];

const PI_OWNED = /* @__PURE__ */ new Set<string>(PI_OWNED_CONFIG_KEYS);

/** Keys whose value is a record of settings in their own right, one per entry. */
const RECORD_KEYS = new Set(["values", "options", "keybindings", "threads", "updates", "confirm", "extensions", "modelPreferences", "modelPrices"]);

/** What core applies when no level sets a key. Kit settings name their own default. */
export const CONFIG_DEFAULTS: Readonly<Record<string, unknown>> = {
  theme: "system",
  transcriptDetail: "focused",
  showCosts: true,
  hostBackground: false,
  hostKeepAwake: false,
  vimMode: false,
  prewarm: true,
  "threads.continueAfterRestart": false,
  "threads.wakeDelivery": "steer",
  "extensions.watch": true,
  "confirm.quit": "hold",
  "confirm.quitWhileRunning": true,
};

/**
 * `showCosts` names a key; `values.tau.appearance.density` names the entry
 * `tau.appearance.density` of the `values` record. Only the first dot splits,
 * because entry names carry dots of their own.
 */
export function settingPath(key: string): [string] | [string, string] {
  const dot = key.indexOf(".");
  if (dot < 0) return [key];
  const head = key.slice(0, dot);
  return RECORD_KEYS.has(head) ? [head, key.slice(dot + 1)] : [key];
}

export function isPiOwnedSetting(key: string): boolean {
  return PI_OWNED.has(settingPath(key)[0]);
}

export function withoutPiOwned(config: TauConfig): TauConfig {
  const result = { ...config } as Record<string, unknown>;
  for (const key of PI_OWNED) delete result[key];
  return result as TauConfig;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The value one level holds for a key, or undefined when it holds none. */
export function layerValue(config: TauConfig | undefined, key: string): unknown {
  if (!config) return undefined;
  const [head, entry] = settingPath(key);
  const value = (config as Record<string, unknown>)[head];
  if (entry === undefined) return value;
  return isRecord(value) ? value[entry] : undefined;
}

/** A copy of one level with the key set. */
export function withSetting(config: TauConfig, key: string, value: unknown): TauConfig {
  const [head, entry] = settingPath(key);
  const result = { ...config } as Record<string, unknown>;
  if (entry === undefined) result[head] = value;
  else result[head] = { ...(isRecord(result[head]) ? result[head] : {}), [entry]: value };
  return result as TauConfig;
}

/** A copy of one level without the key; an emptied record goes too. */
export function withoutSetting(config: TauConfig, key: string): TauConfig {
  const [head, entry] = settingPath(key);
  const result = { ...config } as Record<string, unknown>;
  if (entry === undefined) {
    delete result[head];
    return result as TauConfig;
  }
  if (!isRecord(result[head])) return result as TauConfig;
  const record = { ...result[head] };
  delete record[entry];
  if (Object.keys(record).length === 0) delete result[head];
  else result[head] = record;
  return result as TauConfig;
}

export interface SettingLayerValue {
  layer: ConfigLayerName;
  /** What the level holds; the default level always holds one. */
  value: unknown;
  set: boolean;
  /** The level the value on screen comes from. */
  effective: boolean;
}

export interface ResolvedSetting<T> {
  value: T;
  origin: ConfigLayerName;
  /** Top-down, as far as the level being edited reaches. */
  chain: SettingLayerValue[];
  /** What the project holds while the host level is being edited: it hides the host's value there. */
  projectOverride?: T;
}

/**
 * Where a key's value comes from, for the level being edited. Editing the host
 * shows what every project without its own value gets; editing a project shows
 * what that project gets.
 */
export function resolveSetting<T>(
  layers: ConfigLayers,
  key: string,
  defaultValue: T,
  editing: "host" | "project",
  read: (raw: unknown) => T | undefined = (raw) => raw as T | undefined,
): ResolvedSetting<T> {
  const project = editing === "project" ? read(layerValue(layers.project, key)) : undefined;
  const host = read(layerValue(layers.host, key));
  const origin: ConfigLayerName = project !== undefined ? "project" : host !== undefined ? "host" : "default";
  const chain: SettingLayerValue[] = [];
  if (editing === "project") chain.push({ layer: "project", value: project, set: project !== undefined, effective: origin === "project" });
  chain.push({ layer: "host", value: host, set: host !== undefined, effective: origin === "host" });
  chain.push({ layer: "default", value: defaultValue, set: true, effective: origin === "default" });
  const value = origin === "project" ? project! : origin === "host" ? host! : defaultValue;
  const projectOverride = editing === "host" ? read(layerValue(layers.project, key)) : undefined;
  return { value, origin, chain, ...(projectOverride !== undefined ? { projectOverride } : {}) };
}

/** Whether a setting of this scope can be written at the level being edited. */
export function settingWritable(scope: SettingScope, editing: "host" | "project"): boolean {
  return scope === "both" || scope === editing;
}
