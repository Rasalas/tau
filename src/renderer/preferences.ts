import type { AccessLevel } from "../shared/contracts";

export type { AccessLevel };

export const ACCESS_LEVELS: ReadonlyArray<{ id: AccessLevel; label: string }> = [
  { id: "read-only", label: "read-only" },
  { id: "ask", label: "ask before edits" },
  { id: "full", label: "full access" },
];

export interface PreferencesState {
  accessLevel: AccessLevel;
  editorId?: string;
  settledThreadIds: readonly string[];
  /** Favourite models, keyed `provider/id`. */
  favouriteModels: readonly string[];
  /** Keyed `extensionId.optionId`. */
  extensionOptions: Readonly<Record<string, boolean>>;
  disabledExtensions: readonly string[];
}

const STORAGE_KEY = "tau.preferences";

const DEFAULTS: PreferencesState = {
  accessLevel: "full",
  settledThreadIds: [],
  favouriteModels: [],
  extensionOptions: {},
  disabledExtensions: [],
};

function isAccessLevel(value: unknown): value is AccessLevel {
  return ACCESS_LEVELS.some((level) => level.id === value);
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function load(): PreferencesState {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    const options: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw.extensionOptions ?? {})) {
      if (typeof value === "boolean") options[key] = value;
    }
    return {
      accessLevel: isAccessLevel(raw.accessLevel) ? raw.accessLevel : DEFAULTS.accessLevel,
      editorId: typeof raw.editorId === "string" ? raw.editorId : undefined,
      settledThreadIds: stringList(raw.settledThreadIds),
      favouriteModels: stringList(raw.favouriteModels),
      extensionOptions: options,
      disabledExtensions: stringList(raw.disabledExtensions),
    };
  } catch {
    return DEFAULTS;
  }
}

export class PreferencesStore {
  private state: PreferencesState = load();
  private listeners = new Set<() => void>();

  getSnapshot = (): PreferencesState => this.state;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setAccessLevel(accessLevel: AccessLevel): void {
    this.update({ accessLevel });
  }

  setEditor(editorId: string): void {
    this.update({ editorId });
  }

  optionValue(extensionId: string, optionId: string, fallback: boolean): boolean {
    return this.state.extensionOptions[`${extensionId}.${optionId}`] ?? fallback;
  }

  setOption(extensionId: string, optionId: string, value: boolean): void {
    this.update({
      extensionOptions: { ...this.state.extensionOptions, [`${extensionId}.${optionId}`]: value },
    });
  }

  isExtensionEnabled(extensionId: string): boolean {
    return !this.state.disabledExtensions.includes(extensionId);
  }

  setExtensionEnabled(extensionId: string, enabled: boolean): void {
    const disabled = this.state.disabledExtensions.filter((id) => id !== extensionId);
    this.update({ disabledExtensions: enabled ? disabled : [...disabled, extensionId] });
  }

  toggleFavouriteModel(key: string): void {
    const favourites = this.state.favouriteModels;
    this.update({
      favouriteModels: favourites.includes(key)
        ? favourites.filter((entry) => entry !== key)
        : [...favourites, key],
    });
  }

  isSettled(threadId: string): boolean {
    return this.state.settledThreadIds.includes(threadId);
  }

  toggleSettled(threadId: string): void {
    const settled = this.state.settledThreadIds;
    this.update({
      settledThreadIds: settled.includes(threadId)
        ? settled.filter((id) => id !== threadId)
        : [...settled, threadId],
    });
  }

  private update(patch: Partial<PreferencesState>): void {
    this.state = { ...this.state, ...patch };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state));
    } catch {
      // Preferences are a convenience; a full or blocked store is not worth surfacing.
    }
    this.listeners.forEach((listener) => listener());
  }
}

export const preferences = new PreferencesStore();
