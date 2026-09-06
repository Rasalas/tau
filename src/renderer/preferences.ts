import { getClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { isTranscriptDetail, type TranscriptDetail } from "../workbench/transcript-folding";

export interface PreferencesState {
  /** How much of a turn's work the transcript shows; see `TranscriptDetail`. */
  transcriptDetail: TranscriptDetail;
  /** One thread reading at another level; ephemeral, and never persisted. */
  transcriptDetailOverride?: { threadId: string; level: TranscriptDetail };
  /** Whether the workbench shows what threads cost. */
  showCosts: boolean;
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
  transcriptDetail: "focused",
  showCosts: true,
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
      // `showThinking` was the old two-state version of this: someone who
      // expanded thinking asked for the level that shows it.
      transcriptDetail: isTranscriptDetail(raw.transcriptDetail)
        ? raw.transcriptDetail
        : raw.showThinking === true ? "detailed" : "focused",
      showCosts: raw.showCosts !== false,
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

  /** The level every thread reads at until one of them is given its own. */
  setTranscriptDetail(transcriptDetail: TranscriptDetail): void {
    this.update({ transcriptDetail, transcriptDetailOverride: undefined });
  }

  transcriptDetailFor(threadId: string | undefined): TranscriptDetail {
    const override = this.state.transcriptDetailOverride;
    return threadId !== undefined && override?.threadId === threadId ? override.level : this.state.transcriptDetail;
  }

  /**
   * One thread's own level. Only one thread holds an override at a time, so
   * leaving a thread — or closing it — puts it back on the default by itself.
   */
  overrideTranscriptDetail(threadId: string, level: TranscriptDetail): void {
    this.update({ transcriptDetailOverride: { threadId, level } });
  }

  setShowCosts(showCosts: boolean): void {
    this.update({ showCosts });
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
      const { transcriptDetailOverride: _ephemeral, ...persisted } = this.state;
      getClientStorage()?.set(STORAGE_KEYS.preferences, JSON.stringify(persisted));
    } catch {
      // Preferences are a convenience; a full or blocked store is not worth surfacing.
    }
    this.listeners.forEach((listener) => listener());
  }
}
