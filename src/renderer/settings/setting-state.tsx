import { createContext, useContext, useEffect, useLayoutEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { resolveSetting, settingPath, settingWritable, type ConfigLayerName, type SettingLayerValue, type SettingScope } from "../../shared/config-layers";
import { PERSON_PREFERENCE_KEYS } from "../../shared/person-preferences";
import { ConfigLayersStore, type ConfigLayersSnapshot, type SettingsMachine, type SettingsProject } from "../../workbench/config-layers-store";
import { useHostClient } from "../host-client-context";
import { useHostCapabilities } from "../use-host-capabilities";
import { usePreferences } from "../renderer-services-context";

const SettingsLevelsContext = createContext<ConfigLayersStore | undefined>(undefined);

/** The levels every row inside reads and writes; the Settings screen provides one. */
export function SettingsLevelsProvider({ store, children }: { store: ConfigLayersStore; children: ReactNode }) {
  return <SettingsLevelsContext.Provider value={store}>{children}</SettingsLevelsContext.Provider>;
}

/** The store of the Settings screen, or one of its own for a row drawn anywhere else. */
export function useSettingsLevels(): { store: ConfigLayersStore; snapshot: ConfigLayersSnapshot } {
  const provided = useContext(SettingsLevelsContext);
  const client = useHostClient();
  const preferences = usePreferences();
  const [own] = useState(() => provided ? undefined : new ConfigLayersStore(client, () => void preferences.syncFromHost()));
  useEffect(() => { if (own) void own.refresh(); }, [own]);
  const store = provided ?? own!;
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
  return { store, snapshot };
}

/** The levels with nothing to subscribe to, for a row drawn where no Settings screen provides any. */
const NO_LEVELS = { subscribe: () => () => undefined, getSnapshot: (): ConfigLayersSnapshot | undefined => undefined };

/** The snapshot of the Settings screen the row is in, or undefined outside one. */
export function useProvidedLevels(): ConfigLayersSnapshot | undefined {
  const provided = useContext(SettingsLevelsContext) ?? NO_LEVELS;
  return useSyncExternalStore(provided.subscribe, provided.getSnapshot);
}

const PERSON_KEYS = new Set<string>(PERSON_PREFERENCE_KEYS);

const WHOLE_MACHINE = "Applies to the whole machine.";

/**
 * Why a change cannot be written at the level being edited, when that is the
 * setting's scope and not the device's pairing; undefined where it can.
 */
export function levelLock(key: string, scope: SettingScope, level: Pick<ConfigLayersSnapshot, "editing" | "machine">): string | undefined {
  if (level.machine) return PERSON_KEYS.has(settingPath(key)[0]) ? "Personal: applies on every machine." : level.machine.blocked;
  if (settingWritable(scope, level.editing)) return undefined;
  return level.editing === "project" ? WHOLE_MACHINE : "Applies to each project: choose one in Applies to.";
}

export interface SettingOptions<T> {
  /** What applies when no level sets the key. */
  defaultValue: T;
  /** The levels the setting may be written to; "host" unless it means something per project. */
  scope?: SettingScope;
  /** Turns what a level holds into a value; undefined skips that level. */
  read?(raw: unknown): T | undefined;
  /** What is written for a value; the value itself by default. */
  write?(value: T): unknown;
  /** How a value reads in the origin popover. */
  format?(value: T): string;
  /** Where a change goes when there is no host to write a level to: the client's own preferences. */
  offline?(value: T): void;
}

export interface SettingHandle<T> {
  key: string;
  scope: SettingScope;
  value: T;
  origin: ConfigLayerName;
  chain: readonly SettingLayerValue[];
  /** While the host level is edited: what the project holds, which hides the host's value there. */
  projectOverride?: T;
  editing: "host" | "project";
  project?: SettingsProject;
  /** The other machine whose machine level is edited, instead of this one's. */
  machine?: SettingsMachine;
  writable: boolean;
  /** Why the level being edited cannot hold this setting, in a few words. */
  lock?: string;
  /** Why it is not writable when that is the device's pairing, not the level (API 1.13.0). */
  readOnly?: boolean;
  loaded: boolean;
  set(value: T): void;
  /** Removes the value from the level being edited. */
  reset(): void;
  /** Edits the project level, for an override. */
  editProject(): void;
  format(value: unknown): string;
}

function defaultFormat(value: unknown): string {
  return typeof value === "boolean" ? (value ? "On" : "Off") : value === "" ? "Empty" : String(value);
}

/**
 * One key of Tau's config read across the levels (default, host, project):
 * its value for the level being edited, where that value comes from, and a
 * setter that writes to that level. `key` is a config path: `showCosts`, or an
 * entry of a record such as `values.<extension>.<name>`.
 */
export function useSetting<T>(key: string, options: SettingOptions<T>): SettingHandle<T> {
  const { store, snapshot } = useSettingsLevels();
  const { readOnly } = useHostCapabilities();
  const scope = options.scope ?? "host";
  const projectScoped = scope !== "host";
  // A project is only worth offering where a row on screen can hold one.
  useLayoutEffect(() => (projectScoped ? store.declareProjectSetting() : undefined), [store, projectScoped]);
  const lock = levelLock(key, scope, snapshot);
  const resolved = resolveSetting(snapshot.layers, key, options.defaultValue, snapshot.editing, options.read);
  const format = (value: unknown) => (value == null ? "Not set" : (options.format ?? defaultFormat)(value as T));
  return {
    key,
    scope,
    value: resolved.value,
    origin: resolved.origin,
    chain: resolved.chain,
    ...(resolved.projectOverride !== undefined ? { projectOverride: resolved.projectOverride } : {}),
    editing: snapshot.editing,
    ...(snapshot.project ? { project: snapshot.project } : {}),
    ...(snapshot.machine ? { machine: snapshot.machine } : {}),
    writable: !readOnly && lock === undefined,
    ...(lock ? { lock } : {}),
    ...(readOnly ? { readOnly } : {}),
    loaded: snapshot.loaded,
    set: (value) => {
      if (store.available) void store.write(key, options.write ? options.write(value) : value);
      else options.offline?.(value);
    },
    reset: () => void store.clear(key),
    editProject: () => store.edit("project"),
    format,
  };
}
