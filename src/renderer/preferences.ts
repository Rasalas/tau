import { getClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { isTranscriptDetail, type TranscriptDetail } from "../workbench/transcript-folding";
import type { HostClient } from "../workbench/host-client";
import type { TauConfig } from "../shared/contracts";
import { DEFAULT_THEME, isThemePreference, registerUserThemes, applyTheme, type ThemePreference } from "./theme";
import { SEND_SHORTCUTS, type SendShortcut } from "./components/composer-send-keys";

export interface PreferencesState {
  /** How much of a turn's work the transcript shows; see `TranscriptDetail`. */
  transcriptDetail: TranscriptDetail;
  /** One thread reading at another level; ephemeral, and never persisted. */
  transcriptDetailOverride?: { threadId: string; level: TranscriptDetail };
  /** Whether the workbench shows what threads cost. */
  showCosts: boolean;
  /** Whether the host picks a thread back up when a restart cut its turn short. */
  continueThreadsAfterRestart: boolean;
  /** Which token set the window paints with; `system` follows the OS. */
  theme: ThemePreference;
  editorId?: string;
  settledThreadIds: readonly string[];
  pinnedThreadIds: readonly string[];
  /** Favourite models, keyed `provider/id`. */
  favouriteModels: readonly string[];
  /** The runtime backend a new thread is created on; unset means the host's default. */
  newThreadRuntime?: string;
  /** Keyed `extensionId.optionId`. */
  extensionOptions: Readonly<Record<string, boolean>>;
  /** Small per-extension values, keyed `extensionId.key`; extensions own their meaning. */
  extensionValues: Readonly<Record<string, string>>;
  disabledExtensions: readonly string[];
  keybindings?: Readonly<Record<string, string>>;
  fontFamily?: string;
  fontSize?: number;
  temperature?: number;
  maxTokens?: number;
  vimMode?: boolean;
  /** Which chord sends from the composer; this client's own, like its keys. */
  sendShortcut: SendShortcut;
  /** Leave the host process running when the app quits; its threads keep going. */
  hostBackground?: boolean;
}

/** Preferences that are keys of the host's config under the same name. */
const SCALARS = ["theme", "transcriptDetail", "showCosts", "fontFamily", "fontSize", "temperature", "maxTokens", "vimMode", "hostBackground"] as const;

const DEFAULTS: PreferencesState = {
  transcriptDetail: "focused",
  showCosts: true,
  continueThreadsAfterRestart: false,
  theme: DEFAULT_THEME,
  settledThreadIds: [],
  pinnedThreadIds: [],
  favouriteModels: [],
  extensionOptions: {},
  extensionValues: {},
  disabledExtensions: [],
  vimMode: false,
  sendShortcut: "enter",
  hostBackground: false,
};

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function load(): PreferencesState {
  try {
    const storage = getClientStorage();
    let rawJson = storage?.get(STORAGE_KEYS.preferences);
    // Migrate from unversioned key if present
    if (!rawJson) {
      const legacy = storage?.get(STORAGE_KEYS.preferencesLegacy);
      if (legacy) {
        rawJson = legacy;
        // Write to new key and clean up old one
        storage?.set(STORAGE_KEYS.preferences, legacy);
        storage?.remove(STORAGE_KEYS.preferencesLegacy);
      }
    }
    const raw = JSON.parse(rawJson ?? "{}") as Record<string, unknown>;
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
    // So were the subscription-login acknowledgements, before that warning became a kit.
    const acknowledged = stringList(raw.acknowledgedSubscriptionLogins);
    if (acknowledged.length > 0 && !("tau.subscription-login.acknowledged" in values)) values["tau.subscription-login.acknowledged"] = acknowledged.join(",");
    return {
      // `showThinking` was the old two-state version of this: someone who
      // expanded thinking asked for the level that shows it.
      transcriptDetail: isTranscriptDetail(raw.transcriptDetail)
        ? raw.transcriptDetail
        : raw.showThinking === true ? "detailed" : "focused",
      showCosts: raw.showCosts !== false,
      continueThreadsAfterRestart: raw.continueThreadsAfterRestart === true,
      theme: isThemePreference(raw.theme) ? raw.theme : DEFAULT_THEME,
      editorId: typeof raw.editorId === "string" ? raw.editorId : undefined,
      settledThreadIds: stringList(raw.settledThreadIds),
      pinnedThreadIds: stringList(raw.pinnedThreadIds),
      favouriteModels: stringList(raw.favouriteModels),
      newThreadRuntime: typeof raw.newThreadRuntime === "string" ? raw.newThreadRuntime : undefined,
      extensionOptions: options,
      extensionValues: values,
      disabledExtensions: stringList(raw.disabledExtensions),
      keybindings: raw.keybindings && typeof raw.keybindings === "object" ? raw.keybindings as Record<string, string> : undefined,
      fontFamily: typeof raw.fontFamily === "string" ? raw.fontFamily : undefined,
      fontSize: typeof raw.fontSize === "number" ? raw.fontSize : undefined,
      temperature: typeof raw.temperature === "number" ? raw.temperature : undefined,
      maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
      vimMode: typeof raw.vimMode === "boolean" ? raw.vimMode : false,
      sendShortcut: SEND_SHORTCUTS.includes(raw.sendShortcut as SendShortcut) ? raw.sendShortcut as SendShortcut : "enter",
    };
  } catch {
    return DEFAULTS;
  }
}

export class PreferencesStore {
  private state: PreferencesState = load();
  private listeners = new Set<() => void>();
  private hostClient?: HostClient;
  private activeWorkspaceId?: string;
  /** The effective config the host answered with last; see `applyConfig`. */
  private lastHostConfig?: TauConfig;

  bindHost(client: HostClient, workspaceId?: string): void {
    this.hostClient = client;
    // App binds once, after the effect that names the workspace may already have run.
    this.activeWorkspaceId = workspaceId ?? this.activeWorkspaceId;
    void this.syncFromHost();
  }

  setWorkspace(workspaceId?: string): void {
    this.activeWorkspaceId = workspaceId;
    void this.syncFromHost();
  }

  async syncFromHost(): Promise<void> {
    if (!this.hostClient) return;
    try {
      if (this.hostClient.listUserThemes) {
        const userThemes = await this.hostClient.listUserThemes(this.activeWorkspaceId);
        registerUserThemes(userThemes);
      }
      const config = await this.hostClient.getConfig(this.activeWorkspaceId);
      this.applyConfig(config);
      applyTheme(this.state.theme);
    } catch {
      // Host might be offline or without config method
    }
  }

  applyConfig(config: TauConfig): void {
    const previous = this.lastHostConfig;
    this.lastHostConfig = config;
    // What the host said last time and no longer says is gone from every level
    // (a cleared override, another project's value), so it is forgotten here too.
    const record = <T,>(local: Readonly<Record<string, T>>, before: Record<string, T> | undefined, now: Record<string, T> | undefined) => {
      const kept = { ...local };
      for (const key of Object.keys(before ?? {})) if (!now || !(key in now)) delete kept[key];
      return { ...kept, ...(now ?? {}) };
    };
    const patch: Partial<PreferencesState> = {};
    const target = patch as Record<string, unknown>;
    for (const key of SCALARS) {
      const value = config[key];
      if (key === "theme" ? isThemePreference(value) : key === "transcriptDetail" ? isTranscriptDetail(value) : value !== undefined) target[key] = value;
      else if (previous?.[key] !== undefined) target[key] = DEFAULTS[key];
    }
    if (config.threads?.continueAfterRestart !== undefined) patch.continueThreadsAfterRestart = config.threads.continueAfterRestart;
    else if (previous?.threads?.continueAfterRestart !== undefined) patch.continueThreadsAfterRestart = DEFAULTS.continueThreadsAfterRestart;
    if (config.favouriteModels) patch.favouriteModels = config.favouriteModels;
    if (config.disabledExtensions) patch.disabledExtensions = config.disabledExtensions;
    if (config.options || previous?.options) patch.extensionOptions = record(this.state.extensionOptions, previous?.options, config.options);
    if (config.values || previous?.values) patch.extensionValues = record(this.state.extensionValues, previous?.values, config.values);
    if (config.keybindings || previous?.keybindings) patch.keybindings = record(this.state.keybindings ?? {}, previous?.keybindings, config.keybindings);
    this.update(patch, false);
  }

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

  setHostBackground(hostBackground: boolean): void {
    this.update({ hostBackground });
  }

  setContinueThreadsAfterRestart(continueThreadsAfterRestart: boolean): void {
    this.update({ continueThreadsAfterRestart });
  }

  setTheme(theme: ThemePreference): void {
    this.update({ theme });
  }

  setFontSize(fontSize: number | undefined): void {
    this.update({ fontSize });
  }

  setFontFamily(fontFamily: string | undefined): void {
    this.update({ fontFamily });
  }

  setEditor(editorId: string): void {
    this.update({ editorId });
  }

  setVimMode(vimMode: boolean): void {
    this.update({ vimMode });
  }

  setSendShortcut(sendShortcut: SendShortcut): void {
    this.update({ sendShortcut });
  }

  setTemperature(temperature: number | undefined): void {
    this.update({ temperature });
  }

  setMaxTokens(maxTokens: number | undefined): void {
    this.update({ maxTokens });
  }

  optionValue(extensionId: string, optionId: string, fallback: boolean): boolean {
    return this.state.extensionOptions[`${extensionId}.${optionId}`] ?? fallback;
  }

  setOption(extensionId: string, optionId: string, value: boolean): void {
    const key = `${extensionId}.${optionId}`;
    this.update({ extensionOptions: { ...this.state.extensionOptions, [key]: value } }, true, { options: { [key]: value } });
  }

  value(extensionId: string, key: string): string | undefined {
    return this.state.extensionValues[`${extensionId}.${key}`];
  }

  setValue(extensionId: string, key: string, value: string): void {
    const entry = `${extensionId}.${key}`;
    if (this.state.extensionValues[entry] === value) return;
    // Only the entry travels: the whole record would copy a project's own values into the host's file.
    this.update({ extensionValues: { ...this.state.extensionValues, [entry]: value } }, true, { values: { [entry]: value } });
  }

  isExtensionEnabled(extensionId: string): boolean {
    return !this.state.disabledExtensions.includes(extensionId);
  }

  setExtensionEnabled(extensionId: string, enabled: boolean): void {
    const disabled = this.state.disabledExtensions.filter((id) => id !== extensionId);
    this.update({ disabledExtensions: enabled ? disabled : [...disabled, extensionId] });
  }

  setNewThreadRuntime(newThreadRuntime: string | undefined): void {
    this.update({ newThreadRuntime });
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

  private update(patch: Partial<PreferencesState>, syncHost = true, explicitHostPatch?: Partial<TauConfig>): void {
    this.state = { ...this.state, ...patch };
    try {
      const { transcriptDetailOverride: _ephemeral, ...persisted } = this.state;
      getClientStorage()?.set(STORAGE_KEYS.preferences, JSON.stringify(persisted));
    } catch {
      // Preferences are a convenience; a full or blocked store is not worth surfacing.
    }
    if (syncHost && this.hostClient && explicitHostPatch) {
      void this.hostClient.updateConfig(explicitHostPatch, "global", this.activeWorkspaceId).catch(() => {});
    } else if (syncHost && this.hostClient) {
      const hostPatch: Partial<TauConfig> = {};
      for (const key of SCALARS) if (patch[key] !== undefined) (hostPatch as Record<string, unknown>)[key] = patch[key];
      if (patch.continueThreadsAfterRestart !== undefined) hostPatch.threads = { continueAfterRestart: patch.continueThreadsAfterRestart };
      if (patch.favouriteModels) hostPatch.favouriteModels = [...patch.favouriteModels];
      if (patch.disabledExtensions) hostPatch.disabledExtensions = [...patch.disabledExtensions];
      if (patch.extensionOptions) hostPatch.options = { ...patch.extensionOptions };
      if (patch.extensionValues) hostPatch.values = { ...patch.extensionValues };
      if (patch.keybindings) hostPatch.keybindings = { ...patch.keybindings };
      void this.hostClient.updateConfig(hostPatch, "global", this.activeWorkspaceId).catch(() => {});
    }
    this.listeners.forEach((listener) => listener());
  }
}
