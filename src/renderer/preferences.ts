import { getClientStorage } from "./client-storage";
import { STORAGE_KEYS } from "./storage-keys";

export interface PreferencesState {
  /** Whether assistant thinking blocks start expanded, like Ctrl+T in Pi's terminal. */
  showThinking: boolean;
  editorId?: string;
  settledThreadIds: readonly string[];
  pinnedThreadIds: readonly string[];
  /** Favourite models, keyed `provider/id`. */
  favouriteModels: readonly string[];
  /** Keyed `extensionId.optionId`. */
  extensionOptions: Readonly<Record<string, boolean>>;
  /** Small per-extension values, keyed `extensionId.key`; extensions own their meaning. */
  extensionValues: Readonly<Record<string, string>>;
  disabledExtensions: readonly string[];
}

const DEFAULTS: PreferencesState = {
  showThinking: false,
  settledThreadIds: [],
  pinnedThreadIds: [],
  favouriteModels: [],
  extensionOptions: {},
  extensionValues: {},
  disabledExtensions: [],
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function load(): PreferencesState {
  try {
    const raw = JSON.parse(getClientStorage()?.get(STORAGE_KEYS.preferences) ?? "{}") as Record<string, unknown>;
    const options: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(raw.extensionOptions ?? {})) {
      if (typeof value === "boolean") options[key] = value;
    }
    const values: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw.extensionValues ?? {})) {
      if (typeof value === "string") values[key] = value;
    }
    // The access level lived in core before Access Kit owned it.
    if (typeof raw.accessLevel === "string" && !("tau.access.level" in values)) values["tau.access.level"] = raw.accessLevel;
    return {
      showThinking: raw.showThinking === true,
      editorId: typeof raw.editorId === "string" ? raw.editorId : undefined,
      settledThreadIds: stringList(raw.settledThreadIds),
      pinnedThreadIds: stringList(raw.pinnedThreadIds),
      favouriteModels: stringList(raw.favouriteModels),
      extensionOptions: options,
      extensionValues: values,
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

  setShowThinking(showThinking: boolean): void {
    this.update({ showThinking });
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

  value(extensionId: string, key: string): string | undefined {
    return this.state.extensionValues[`${extensionId}.${key}`];
  }

  setValue(extensionId: string, key: string, value: string): void {
    if (this.state.extensionValues[`${extensionId}.${key}`] === value) return;
    this.update({ extensionValues: { ...this.state.extensionValues, [`${extensionId}.${key}`]: value } });
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

  unsettle(threadId: string): void {
    if (!this.state.settledThreadIds.includes(threadId)) return;
    this.update({ settledThreadIds: this.state.settledThreadIds.filter((id) => id !== threadId) });
  }

  isPinned(threadId: string): boolean {
    return this.state.pinnedThreadIds.includes(threadId);
  }

  togglePinned(threadId: string): void {
    const pinned = this.state.pinnedThreadIds;
    this.update({
      pinnedThreadIds: pinned.includes(threadId)
        ? pinned.filter((id) => id !== threadId)
        : [...pinned, threadId],
    });
  }

  private update(patch: Partial<PreferencesState>): void {
    this.state = { ...this.state, ...patch };
    try {
      getClientStorage()?.set(STORAGE_KEYS.preferences, JSON.stringify(this.state));
    } catch {
      // Preferences are a convenience; a full or blocked store is not worth surfacing.
    }
    this.listeners.forEach((listener) => listener());
  }
}
