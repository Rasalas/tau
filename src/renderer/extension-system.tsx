import type { ReactNode } from "react";
import type { FocusAreaContribution } from "./focus-areas";
import type { ExtensionUiAnswer, ExtensionUiPrompt, UiToolRun } from "../shared/contracts";
import { readProjectIcon } from "../shared/project-icon-choice";
import {
  DEFAULT_CLIENT_PROFILES,
  rendersOnProfile,
  type ClientProfile,
  type ProfiledContribution,
  type ProfileScoped,
} from "../workbench/client-profile";
import { errorMessage } from "../workbench/error-message";
import type { Platform } from "../workbench/platform";
import type { ThreadRowMark } from "../workbench/thread-row-status";
import { toolArgumentSummary } from "../workbench/transcript-folding";
import type { PanelIconComponent } from "./components/PanelIcon";
import type { CustomizablePart, PartKind } from "./customization";
import { ExtensionActivation } from "./extension-activation";
import type {
  CommandContribution,
  CommandSurface,
  ComposerControlContribution,
  ComposerGateContribution,
  ComposerInlineContribution,
  ComposerPlannerContribution,
  ComposerSendModeContribution,
  ComposerSpeedContribution,
  ContributionOwner,
  ConversationViewContribution,
  DesktopExtension,
  DesktopExtensionContext,
  DocumentSourceContribution,
  ExtensionEvent,
  ExtensionOption,
  ExtensionProblem,
  ExtensionSummary,
  ForkPromptContribution,
  HostExtensionBridge,
  HostExtensionClient,
  MessageActionContribution,
  MessageBlockContribution,
  ModelBadgeContribution,
  ModelSelectionContribution,
  NewThreadClaimEvent,
  NewThreadPromptEvent,
  NewThreadPromptGate,
  OverlayContribution,
  PageContribution,
  PaletteSourceContribution,
  PanelContribution,
  ProjectSourceContribution,
  PromptHookContribution,
  PromptRendererContribution,
  PromptSubmittedEvent,
  RegionContribution,
  RegionPlacement,
  SettingsPageContribution,
  SettingsSectionContribution,
  SettingsSectionPage,
  SidebarContribution,
  SlashCommandContribution,
  SlotPlacement,
  StageTabContribution,
  StatusItemContribution,
  ThreadLineage,
  ThreadListAccessoryContribution,
  ThreadListLayout,
  ThreadListSource,
  ThreadMenuContribution,
  ToolCardContribution,
  ToolPresentation,
  TranscriptFinderContribution,
  TranscriptRow,
  TranscriptRowsHandle,
  WorkbenchActions,
  WorkbenchEvent,
  WorkbenchEventType,
} from "./extension-contracts";
import { ExtensionCustomizations } from "./extension-customizations";
import { HostUnavailableError, noHostBridge } from "./extension-host-bridge";
import {
  ExtensionKeybindings,
  type KeybindingCollision,
  type KeybindingConflict,
  type ResolvedKeybinding,
  type UserKeybinding,
  type UserKeymapContribution,
} from "./extension-keybindings";
import { runAll, throwFailures } from "./extension-lifecycle-errors";
import { ExtensionServiceRegistry } from "./extension-service-registry";
import { domKeybindingContext } from "./keybinding-context";
import { PreferencesStore } from "./preferences";
import { providerIconKey } from "./runtime-marks";
export type * from "./extension-contracts";
export { hostExtensionBridge, HostUnavailableError } from "./extension-host-bridge";

export { USER_CONFIG_KEYBINDINGS } from "./extension-keybindings";

export const EMPTY_THREAD_LINEAGE: ThreadLineage = { parents: {}, workingChildren: {} };

/**
 * Puts an extension's stylesheet in the document and takes it out again. A
 * Dynamically inserted links do not block paint. Startup waits for their load
 * before revealing the workbench; each extension still owns its stylesheet.
 */
function mountStyles(extension: DesktopExtension): (() => void) | undefined {
  const styles = extension.styles;
  if (!styles?.url && !styles?.css) return undefined;
  const element = styles.url
    ? Object.assign(document.createElement("link"), { rel: "stylesheet", href: styles.url })
    : Object.assign(document.createElement("style"), { textContent: styles.css ?? "" });
  element.dataset.tauExtension = extension.id;
  if (element instanceof HTMLLinkElement) {
    const ready = new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        element.removeEventListener("load", finish);
        element.removeEventListener("error", finish);
        resolve();
      };
      // A broken stylesheet must not leave the whole workbench hidden.
      const timeout = setTimeout(finish, 5_000);
      element.addEventListener("load", finish, { once: true });
      element.addEventListener("error", finish, { once: true });
    });
    stylesheetLoads.set(element, ready);
  }
  document.head.append(element);
  return () => { element.remove(); };
}

const stylesheetLoads = new WeakMap<HTMLLinkElement, Promise<void>>();

interface ToolRenderer {
  id: string;
  match: (tool: UiToolRun) => boolean;
  render: (tool: UiToolRun) => ToolPresentation;
}

type Owned<T> = T & ContributionOwner;

/** What a contribution this client does not draw hands back: nothing to dispose. */
const noContribution = (): void => undefined;
const noTranscriptRows: TranscriptRowsHandle = {
  setRows: () => undefined,
  clear: () => undefined,
  dispose: () => undefined,
};

export class ExtensionRegistry {
  readonly #hostEventListeners = new Map<string, Map<string, Set<(payload: unknown) => void>>>();

  private readonly services: { preferences: PreferencesStore; platform?: () => Platform | undefined };

  /** Which client is drawing. Every renderable contribution is filtered against it. */
  private readonly profile: ClientProfile;
  private readonly keybindings: ExtensionKeybindings;

  // `services` defaults to a private store so the many tests that build a
  // registry without a workbench keep working; real activation passes the
  // renderer's shared instance explicitly.

  constructor(
    private readonly hostBridge: HostExtensionBridge = noHostBridge,
    services?: { preferences: PreferencesStore; profile?: ClientProfile; platform?: () => Platform | undefined },
  ) {
    this.services = services ?? { preferences: new PreferencesStore() };
    this.profile = services?.profile ?? "desktop";
    this.keybindings = new ExtensionKeybindings(this.profile, () => this.changed());
    this.services.preferences.subscribe(() => {
      this.applyKeybindingOverrides(this.services.preferences.getSnapshot().keybindings);
    });
    this.applyKeybindingOverrides(this.services.preferences.getSnapshot().keybindings);
  }

  getProfile(): ClientProfile {
    return this.profile;
  }

  #panels = new Map<string, Owned<PanelContribution>>();
  #stageTabKinds = new Map<string, Owned<StageTabContribution>>();
  #settingsPages = new Map<string, Owned<SettingsPageContribution>>();
  #pages = new Map<string, Owned<PageContribution>>();
  #settingsSections = new Map<string, Owned<SettingsSectionContribution>>();
  #composerControls = new Map<string, Owned<ComposerControlContribution>>();
  #composerInlines = new Map<string, Owned<ComposerInlineContribution>>();
  #composerGates = new Map<string, Owned<ComposerGateContribution>>();
  #modelBadges = new Map<string, Owned<ModelBadgeContribution>>();
  #composerSpeeds = new Map<string, Owned<ComposerSpeedContribution>>();
  #composerSendModes = new Map<string, Owned<ComposerSendModeContribution>>();
  #composerPlanners = new Map<string, Owned<ComposerPlannerContribution>>();
  #regions = new Map<string, Owned<RegionContribution>>();
  #statusItems = new Map<string, Owned<StatusItemContribution>>();
  #overlays = new Map<string, Owned<OverlayContribution>>();
  #conversationViews = new Map<string, Owned<ConversationViewContribution>>();
  readonly #workbenchEventListeners = new Map<WorkbenchEventType, Set<(event: WorkbenchEvent) => void>>();
  #transcriptRows = new Map<string, { order: number; owner: ContributionOwner; bySession: Map<string, readonly TranscriptRow[]> }>();
  /** Waiting labels per extension and thread; the first extension's label wins. */
  #liveStatuses = new Map<string, Map<string, string>>();
  #rowMarks = new Map<string, Readonly<Record<string, ThreadRowMark<ReactNode>>>>();
  #mergedRowMarks: { version: number; marks: Readonly<Record<string, ThreadRowMark<ReactNode>>> } | undefined;
  /** Thread lineage per extension; entries merge, the first extension's answer wins. */
  #lineages = new Map<string, ThreadLineage>();
  #lineageCache: { version: number; value: ThreadLineage } | undefined;
  #projectIcons = new Map<string, Readonly<Record<string, string>>>();
  #providerIcons = new Map<string, Readonly<Record<string, string>>>();
  #problems = new Map<string, Array<ExtensionProblem & ContributionOwner>>();
  #sidebarContributions = new Map<string, Owned<SidebarContribution>>();
  #projectSources = new Map<string, Owned<ProjectSourceContribution>>();
  #threadListSources = new Map<string, Owned<ThreadListSource>>();
  #threadListAccessories = new Map<string, Owned<ThreadListAccessoryContribution>>();
  #threadListLayouts = new Map<string, Owned<ThreadListLayout>>();
  #commands = new Map<string, Owned<CommandContribution>>();
  #focusAreas = new Map<string, Owned<FocusAreaContribution>>();
  #paletteSources = new Map<string, Owned<PaletteSourceContribution>>();
  #slashCommands = new Map<string, Owned<SlashCommandContribution>>();
  #promptHooks = new Map<string, Owned<PromptHookContribution>>();
  #modelSelections = new Map<string, Owned<ModelSelectionContribution>>();
  #threadMenus = new Map<string, Owned<ThreadMenuContribution>>();
  #forkPrompts = new Map<string, Owned<ForkPromptContribution>>();
  #messageActions = new Map<string, Owned<MessageActionContribution>>();
  #messageBlocks = new Map<string, Owned<MessageBlockContribution>>();
  #transcriptFinders = new Map<string, Owned<TranscriptFinderContribution>>();
  #promptRenderers = new Map<string, Owned<PromptRendererContribution>>();
  #documentSources = new Map<string, Owned<DocumentSourceContribution>>();
  #userKeymaps = new Map<string, Owned<UserKeymapContribution>>();
  /** Values one extension published for another; core only routes them by id. */
  readonly #extensionServices = new ExtensionServiceRegistry();
  #renderers = new Map<string, Owned<ToolRenderer>>();
  #toolCards = new Map<string, Owned<ToolCardContribution>>();
  #options = new Map<string, ExtensionOption[]>();
  #contributionKinds = new Map<string, string[]>();
  /** Every renderable contribution an active extension offered, with the clients it claims. */
  #profiledContributions = new Map<string, ProfiledContribution[]>();
  /** The first runtime and icon each extension's contributions named, drawn here or not; kept while it is off. */
  #marks = new Map<string, { runtime?: string; Icon?: PanelIconComponent }>();
  #known = new Map<string, DesktopExtension>();
  /** Ids core activated itself; they are listed but never switched off. */
  readonly #coreIds = new Set<string>();
  #activeExtensions = new Map<string, { extension: DesktopExtension; activation: ExtensionActivation }>();
  readonly #activationTransitions = new Map<string, { next: DesktopExtension | false | undefined }>();
  #listeners = new Set<() => void>();
  #version = 0;
  #legacyVersion = 0;
  #registrationListeners = new Set<() => void>();
  #dataListeners = new Map<string, Set<() => void>>();
  #dataVersions = new Map<string, number>();
  #problemCache: Array<ExtensionProblem & ContributionOwner> | undefined;
  readonly #emptyTranscriptRows: TranscriptRow[] = [];
  #transcriptCache = new Map<string, TranscriptRow[]>();
  #loadingExtensions = false;
  /** The last failure per extension entry path; an entry that builds again drops out. */
  readonly #loadFailures = new Map<string, string>();
  #sortedCache = new Map<string, { version: number; value: unknown[] }>();
  readonly #customization = new ExtensionCustomizations(() => this.changed());

  /**
   * Records a renderable contribution and answers whether this client draws it.
   * A contribution the profile does not render is never registered, so its
   * component never mounts; it stays on the list Settings shows.
   */
  private scopeToProfile(owner: ContributionOwner, kind: string, id: string, label: string | undefined, scoped: ProfileScoped | undefined): boolean {
    const own = this.#profiledContributions.get(owner.extensionId) ?? [];
    this.#profiledContributions.set(owner.extensionId, own);
    const { runtime, Icon } = (scoped ?? {}) as { runtime?: unknown; Icon?: PanelIconComponent };
    const mark = this.#marks.get(owner.extensionId) ?? {};
    if (typeof runtime === "string" && !mark.runtime) mark.runtime = runtime;
    if (Icon && !mark.Icon) mark.Icon = Icon;
    if (mark.runtime || mark.Icon) this.#marks.set(owner.extensionId, mark);
    own.push({
      ...owner,
      kind,
      id,
      ...(label === undefined ? {} : { label }),
      profiles: scoped?.profiles ?? DEFAULT_CLIENT_PROFILES,
      declared: scoped?.profiles !== undefined,
    });
    return rendersOnProfile(scoped?.profiles, this.profile);
  }

  /** Every renderable contribution the active extensions offered, drawn here or not. */
  getProfiledContributions(): ProfiledContribution[] {
    return [...this.#profiledContributions.values()].flat();
  }

  /**
   * The runtime and the icon each extension's pages, panels and sections name,
   * including those this client does not draw: a phone shows a runtime kit's
   * mark though its page is the desktop's.
   */
  getContributionMarks(): ReadonlyMap<string, { runtime?: string; Icon?: PanelIconComponent }> {
    return this.#marks;
  }

  /** What this client cannot draw: the "not on this client" list in Settings. */
  getUnrenderedContributions(): ProfiledContribution[] {
    return this.getProfiledContributions().filter((entry) => !rendersOnProfile(entry.profiles, this.profile));
  }

  /**
   * Activates a contribution core itself owns — the runtime commands, their
   * chords, the slash commands core answers. It carries no grant and no switch,
   * and it is on in safe mode too, where no extension is.
   */
  activateCore(extension: DesktopExtension): void {
    this.#coreIds.add(extension.id);
    this.activate(extension);
  }

  /** Make an extension known without activating it, so settings can list and enable it. */
  addKnown(extension: DesktopExtension): void {
    this.#known.set(extension.id, extension);
    this.changed();
  }

  activate(extension: DesktopExtension): void {
    this.transitionActivation(extension.id, extension);
  }

  /** Serialize replacements requested by activation, abort or cleanup callbacks. */
  private transitionActivation(id: string, next: DesktopExtension | false): void {
    const pending = this.#activationTransitions.get(id);
    if (pending) {
      pending.next = next;
      this.deactivateNow(id);
      return;
    }
    const transition: { next: DesktopExtension | false | undefined } = { next };
    this.#activationTransitions.set(id, transition);
    const errors: unknown[] = [];
    try {
      while (transition.next !== undefined) {
        const requested = transition.next;
        transition.next = undefined;
        try {
          this.deactivateNow(id);
          // A callback made a newer request while the old activation ended.
          if (requested && transition.next === undefined) this.activateNow(requested);
        } catch (error) { errors.push(error); }
      }
    } finally {
      this.#activationTransitions.delete(id);
    }
    throwFailures(errors);
  }

  private activateNow(extension: DesktopExtension): void {
    this.#known.set(extension.id, extension);
    const owner: ContributionOwner = { extensionId: extension.id, extensionName: extension.name };
    this.#profiledContributions.delete(extension.id);
    const kinds: string[] = [];
    const activation = new ExtensionActivation();
    const profiled = (...args: Parameters<ExtensionRegistry["scopeToProfile"]>) => activation.active && this.scopeToProfile(...args);
    // Before `activate`, so the rules are in place when the first component mounts.
    const unmountStyles = mountStyles(extension);
    if (unmountStyles) activation.own(unmountStyles);
    const note = (kind: string) => { if (!kinds.includes(kind)) kinds.push(kind); };
    // A theme contributes only its rules; without this the Inspector shows it
    // as an extension that contributes nothing.
    if (unmountStyles) note("styles");
    const contribute = <T extends ProfileScoped>(map: Map<string, Owned<T>>, id: string, value: T, kind: string, label: string | undefined, summary: string): (() => void) => {
      if (!profiled(owner, kind, id, label, value)) return noContribution;
      note(summary);
      return this.register(map, id, { ...value, ...owner }, activation);
    };
    const hostClient = (extensionId: string): HostExtensionClient => ({
      invoke: (command, input) => this.hostBridge.invoke(extensionId, command, input),
      ...(this.hostBridge.resourceUrl ? { resourceUrl: (path: string) => this.hostBridge.resourceUrl!(path) } : {}),
      ...(this.hostBridge.readResource ? { readResource: (path: string) => this.hostBridge.readResource!(path) } : {}),
      onEvent: (name, listener) => {
        if (!activation.active) return noContribution;
        const guarded = activation.guard(listener);
        const byName = this.#hostEventListeners.get(extensionId) ?? new Map<string, Set<(payload: unknown) => void>>();
        this.#hostEventListeners.set(extensionId, byName);
        const listeners = byName.get(name) ?? new Set<(payload: unknown) => void>();
        byName.set(name, listeners);
        listeners.add(guarded);
        const dispose = () => { listeners.delete(guarded); };
        return activation.own(dispose);
      },
      watch: (topic) => {
        if (!activation.active) return noContribution;
        const release = this.hostBridge.watch?.(extensionId, topic) ?? (() => undefined);
        return activation.own(release);
      },
    });
    const platform = this.services.platform;
    const context: DesktopExtensionContext = {
      signal: activation.signal,
      preferences: this.services.preferences,
      // Read when used: the client builds its platform after the registry.
      get attention() { return platform?.()?.attention; },
      get environments() { return platform?.()?.environments; },
      host: hostClient(extension.id),
      hostExtension: (extensionId) => hostClient(extensionId),
      registerPanel: (panel) => contribute(this.#panels, panel.id, panel, "panel", panel.label, panel.label.toLowerCase()),
      registerStageTab: (tab) => {
        const contribution = tab as unknown as StageTabContribution;
        if (!profiled(owner, "stage tab", contribution.kind, contribution.kind, contribution)) return noContribution;
        note("stage tabs");
        return this.register(this.#stageTabKinds, contribution.kind, { ...contribution, ...owner }, activation);
      },
      registerSettingsPage: (page) => contribute(this.#settingsPages, page.id, page, "settings page", page.label, "settings page"),
      registerPage: (page) => contribute(this.#pages, page.id, page, "page", page.label, "page"),
      registerSettingsSection: (section) => contribute(this.#settingsSections, section.id, section, "settings section", section.id, "settings section"),
      inspectPackages: (cwd) => this.hostBridge.inspect
        ? this.hostBridge.inspect(cwd)
        : Promise.reject(new HostUnavailableError()),
      events: {
        on: (type, listener) => {
          if (!activation.active) return noContribution;
          const listeners = this.#workbenchEventListeners.get(type) ?? new Set<(event: WorkbenchEvent) => void>();
          this.#workbenchEventListeners.set(type, listeners);
          const wrapped = activation.guard(listener as (event: WorkbenchEvent) => void);
          listeners.add(wrapped);
          const dispose = () => { listeners.delete(wrapped); };
          return activation.own(dispose);
        },
      },
      registerRegion: (region) => {
        if (!profiled(owner, `${region.placement} region`, region.id, undefined, region)) return noContribution;
        note(`${region.placement} region`);
        return this.register(this.#regions, region.id, { ...region, ...owner }, activation);
      },
      registerStatusItem: (item) => contribute(this.#statusItems, item.id, item, "status item", undefined, "status line"),
      registerOverlay: (overlay) => contribute(this.#overlays, overlay.id, overlay, "overlay", undefined, "overlay"),
      registerConversationView: (view) => contribute(this.#conversationViews, view.id, view, "conversation view", undefined, "conversation view"),
      setLiveStatus: (sessionId, label) => {
        if (!activation.active) return;
        const own = this.#liveStatuses.get(extension.id) ?? new Map<string, string>();
        if (own.get(sessionId) === label) return;
        if (label === undefined) own.delete(sessionId);
        else own.set(sessionId, label);
        if (own.size === 0) this.#liveStatuses.delete(extension.id);
        else this.#liveStatuses.set(extension.id, own);
        this.dataChanged(`thread:${sessionId}`);
      },
      setThreadRowStatuses: (statuses) => {
        if (!activation.active) return;
        if (Object.keys(statuses).length) this.#rowMarks.set(extension.id, statuses);
        else if (!this.#rowMarks.delete(extension.id)) return;
        this.dataChanged("marks");
      },
      setThreadLineage: (lineage) => {
        if (!activation.active) return;
        if (lineage) this.#lineages.set(extension.id, lineage);
        else this.#lineages.delete(extension.id);
        this.dataChanged("lineage");
      },
      setProjectIcons: (icons) => {
        if (!activation.active) return;
        const pictures = Object.fromEntries(Object.entries(icons ?? {}).filter(([, image]) => image.startsWith("data:image/")));
        if (Object.keys(pictures).length > 0) this.#projectIcons.set(extension.id, pictures);
        else if (!this.#projectIcons.delete(extension.id)) return;
        this.dataChanged("project-icons");
      },
      setProviderIcons: (icons) => {
        if (!activation.active) return;
        const pictures = Object.fromEntries(Object.entries(icons ?? {}).filter(([, image]) => image.startsWith("data:image/")).map(([id, image]) => [providerIconKey(id), image]));
        if (Object.keys(pictures).length > 0) this.#providerIcons.set(extension.id, pictures);
        else if (!this.#providerIcons.delete(extension.id)) return;
        this.dataChanged("provider-icons");
      },
      setProblems: (problems) => {
        if (!activation.active) return;
        if (problems.length === 0 && !this.#problems.has(extension.id)) return;
        if (problems.length === 0) this.#problems.delete(extension.id);
        else this.#problems.set(extension.id, problems.map((problem) => ({ ...problem, ...owner })));
        this.dataChanged("problems");
      },
      registerTranscriptRows: (id, order = 0, options) => {
        if (!profiled(owner, "transcript rows", id, undefined, options)) return noTranscriptRows;
        note("transcript rows");
        if (this.#transcriptRows.has(id)) throw new Error(`Contribution id ${id} from ${extension.id} collides with another transcript row source`);
        const source = { order, owner, bySession: new Map<string, readonly TranscriptRow[]>() };
        this.#transcriptRows.set(id, source);
        const dispose = () => {
          if (this.#transcriptRows.get(id) !== source) return;
          this.#transcriptRows.delete(id);
          for (const sessionId of source.bySession.keys()) this.dataChanged(`thread:${sessionId}`, true);
          this.changed();
        };
        const release = activation.own(dispose);
        this.changed();
        return {
          setRows: (sessionId, rows) => {
            if (!activation.active || this.#transcriptRows.get(id) !== source) return;
            if (rows.length === 0) source.bySession.delete(sessionId);
            else source.bySession.set(sessionId, rows);
            this.dataChanged(`thread:${sessionId}`, true);
          },
          clear: (sessionId) => {
            if (!activation.active || this.#transcriptRows.get(id) !== source) return;
            const sessions = sessionId === undefined ? [...source.bySession.keys()] : [sessionId];
            if (sessionId === undefined) source.bySession.clear();
            else source.bySession.delete(sessionId);
            for (const affectedSessionId of sessions) this.dataChanged(`thread:${affectedSessionId}`, true);
          },
          dispose: release,
        };
      },
      registerComposerControl: (control) => contribute(this.#composerControls, control.id, control, "composer control", undefined, "composer controls"),
      registerComposerInline: (inline) => {
        if (!activation.active) return noContribution;
        for (const trigger of inline.triggers ?? []) {
          if ([...trigger.char].length !== 1 || /[\s/$]/u.test(trigger.char)) {
            throw new Error(`Composer trigger "${trigger.char}" from ${extension.id} must be one character other than "/", "$" or a space`);
          }
        }
        if (!profiled(owner, "composer inline", inline.id, undefined, inline)) return noContribution;
        note("composer context");
        return this.register(this.#composerInlines, inline.id, { ...inline, ...owner }, activation);
      },
      registerComposerGate: (gate) => contribute(this.#composerGates, gate.id, gate, "composer gate", undefined, "composer gates"),
      registerModelBadge: (badge) => contribute(this.#modelBadges, badge.id, badge, "model badge", badge.label, "model badges"),
      registerComposerSpeed: (speed) => contribute(this.#composerSpeeds, speed.id, speed, "composer speed", undefined, "composer speed"),
      registerComposerSendMode: (mode) => contribute(this.#composerSendModes, mode.id, mode, "composer send mode", undefined, "composer send mode"),
      registerComposerPlanner: (planner) => contribute(this.#composerPlanners, planner.id, planner, "composer planner", planner.label, "composer planners"),
      provideService: (id, value) => {
        if (!activation.active) return noContribution;
        const withdraw = this.#extensionServices.provide(extension.id, id, value);
        note("services");
        const dispose = () => {
          try { withdraw(); } finally { this.changed(); }
        };
        const release = activation.own(dispose);
        this.changed();
        return release;
      },
      useService: (id, use) => {
        if (!activation.active) return noContribution;
        const dispose = this.#extensionServices.use(extension.id, id, activation.guard(use));
        return activation.own(dispose);
      },
      registerCustomizations: (layer) => {
        if (!activation.active) return noContribution;
        note("customizations");
        const dispose = this.#customization.register(layer);
        return activation.own(dispose);
      },
      customizableParts: () => this.getCustomizableParts(),
      onPartsChanged: (listener) => {
        if (!activation.active) return noContribution;
        const dispose = this.subscribeRegistrations(activation.guard(listener));
        return activation.own(dispose);
      },
      registerSidebar: (contribution) => contribute(this.#sidebarContributions, contribution.id, contribution, "sidebar", undefined, "sidebar"),
      registerProjectSource: (source) => contribute(this.#projectSources, source.id, source, "project source", source.label, "project sources"),
      registerThreadListSource: (source) => {
        note("thread list sources");
        return this.register(this.#threadListSources, source.id, { ...source, ...owner }, activation);
      },
      registerThreadListAccessory: (accessory) => {
        note("thread list accessories");
        return this.register(this.#threadListAccessories, accessory.id, { ...accessory, ...owner }, activation);
      },
      registerThreadListLayout: (layout) => {
        note("thread list layouts");
        return this.register(this.#threadListLayouts, layout.id, { ...layout, ...owner }, activation);
      },
      registerFocusArea: (area) => this.register(this.#focusAreas, area.id, { ...area, ...owner }, activation),
      registerCommand: (command) =>
        this.register(this.#commands, command.id, { ...command, ...owner }, activation),
      registerPaletteSource: (source) => {
        note("palette sources");
        return this.register(this.#paletteSources, source.id, { ...source, ...owner }, activation);
      },
      registerKeybinding: (binding) => {
        if (!activation.active) return noContribution;
        const dispose = this.keybindings.register(binding, owner);
        if (!dispose) return noContribution;
        note("keybindings");
        return activation.own(dispose);
      },
      registerSlashCommand: (command) => {
        if (!activation.active) return noContribution;
        if (!/^[a-z][a-z0-9:-]*$/u.test(command.name)) throw new Error(`Slash command name "${command.name}" from ${extension.id} must be lowercase letters, digits, ":" or "-"`);
        note("slash commands");
        return this.register(this.#slashCommands, command.name, { ...command, ...owner }, activation);
      },
      registerPromptRenderer: (renderer) => contribute(this.#promptRenderers, renderer.id, renderer, "prompt renderer", undefined, "prompt renderers"),
      registerPromptHook: (hook) => {
        note("prompt hooks");
        return this.register(this.#promptHooks, hook.id, { ...hook, ...owner }, activation);
      },
      registerModelSelection: (selection) => {
        note("model selection");
        return this.register(this.#modelSelections, selection.id, { ...selection, ...owner }, activation);
      },
      registerThreadMenu: (menu) => {
        note("thread menu");
        return this.register(this.#threadMenus, menu.id, { ...menu, ...owner }, activation);
      },
      registerForkPrompt: (prompt) => this.register(this.#forkPrompts, prompt.id, { ...prompt, ...owner }, activation),
      registerMessageAction: (action) => contribute(this.#messageActions, action.id, action, "message action", action.label, "message actions"),
      registerMessageBlock: (block) => contribute(this.#messageBlocks, block.id, block, "message block", undefined, "message blocks"),
      registerTranscriptFinder: (finder) => contribute(this.#transcriptFinders, finder.id, finder, "transcript finder", undefined, "transcript finder"),
      registerUserKeymap: (keymap) => {
        note("user keymap");
        return this.register(this.#userKeymaps, keymap.id, { ...keymap, ...owner }, activation);
      },
      registerDocumentSource: (source) => contribute(this.#documentSources, source.id, source, "document source", undefined, "documents"),
      registerToolRenderer: (id, match, render, options) => {
        if (!profiled(owner, "tool renderer", id, undefined, options)) return noContribution;
        note("tool renderers");
        return this.register(this.#renderers, id, { id, match, render, ...owner }, activation);
      },
      registerToolCard: (card) => contribute(this.#toolCards, card.id, card, "tool card", undefined, "tool cards"),
      registerOptions: (options) => {
        if (!activation.active) return noContribution;
        if (this.#options.has(extension.id)) throw new Error(`Extension ${extension.id} registered options more than once`);
        this.#options.set(extension.id, options);
        const dispose = () => {
          this.#options.delete(extension.id);
          this.changed();
        };
        const release = activation.own(dispose);
        this.changed();
        return release;
      },
    };
    this.#activeExtensions.set(extension.id, { extension, activation });
    try {
      const extensionDispose = extension.activate(context);
      if (extensionDispose) activation.own(extensionDispose);
      if (!activation.active || this.#activeExtensions.get(extension.id)?.activation !== activation) return;
      this.#contributionKinds.set(extension.id, kinds);
      this.changed();
    } catch (error) {
      const errors = [error];
      try {
        if (this.#activeExtensions.get(extension.id)?.activation === activation) this.deactivateNow(extension.id);
        else activation.dispose();
      } catch (failure) { errors.push(failure); }
      throwFailures(errors);
    }
  }

  /** Ids of the values extensions have published for one another. */
  getServiceIds(): string[] {
    return this.#extensionServices.ids();
  }

  deactivate(id: string): void {
    this.transitionActivation(id, false);
  }

  private deactivateNow(id: string): void {
    const active = this.#activeExtensions.get(id);
    if (!active) return;
    this.#activeExtensions.delete(id);
    const errors: unknown[] = [];
    try { active.activation.dispose(); } catch (error) { errors.push(error); }
    this.#contributionKinds.delete(id);
    this.#profiledContributions.delete(id);
    try { this.clearPublishedData(id); } catch (error) { errors.push(error); }
    try { this.changed(); } catch (error) { errors.push(error); }
    const transition = this.#activationTransitions.get(id);
    if (errors.length && transition) transition.next = undefined;
    throwFailures(errors);
  }

  /** Published data has the same lifetime on rollback as on deactivation. */
  private clearPublishedData(id: string): void {
    const statusThreads = [...(this.#liveStatuses.get(id)?.keys() ?? [])];
    this.#liveStatuses.delete(id);
    this.#rowMarks.delete(id);
    this.#lineages.delete(id);
    this.#projectIcons.delete(id);
    this.#providerIcons.delete(id);
    this.#problems.delete(id);
    // Invalidate every selector before a subscriber can read the withdrawn state.
    this.#mergedRowMarks = undefined;
    this.#lineageCache = undefined;
    this.#problemCache = undefined;
    const keys = [...statusThreads.map((sessionId) => `thread:${sessionId}`), "marks", "lineage", "project-icons", "provider-icons", "problems"];
    runAll(keys.map((key) => () => this.dataChanged(key)));
  }

  /** Records the user's answer on a known extension so the settings page stops asking. */
  setGranted(id: string, granted: boolean): void {
    const extension = this.#known.get(id);
    if (!extension) return;
    extension.granted = granted;
    this.changed();
  }

  setActive(id: string, active: boolean): void {
    if (active) {
      const extension = this.#known.get(id);
      if (extension && !this.#activeExtensions.has(id)) this.activate(extension);
    } else {
      this.deactivate(id);
    }
  }

  isActive(id: string): boolean {
    return this.#activeExtensions.has(id);
  }

  getPanels(): Array<Owned<PanelContribution>> {
    return this.customized("panel", this.#panels);
  }

  /** The kind that draws a stage tab, while the extension offering it is active. */
  getStageTabKind(kind: string): Owned<StageTabContribution> | undefined {
    return this.#stageTabKinds.get(kind);
  }

  /** Every stage tab kind on offer; a tab of a kind that is gone is closed with it. */
  getStageTabKinds(): Array<Owned<StageTabContribution>> {
    return this.sorted("stage-tab-kinds", this.#stageTabKinds, false);
  }

  /** Pages extensions added to Settings, in `order`. */
  getSettingsPages(): Array<Owned<SettingsPageContribution>> {
    return this.sorted("settings-pages", this.#settingsPages);
  }

  /** Pages of the app extensions added, in `order`. */
  getPages(): Array<Owned<PageContribution>> {
    return this.customized("page", this.#pages);
  }

  getPage(id: string | undefined): Owned<PageContribution> | undefined {
    return id ? this.getPages().find((page) => page.id === id) : undefined;
  }

  /** Sections packages added to one of core's Settings pages, in `order`. */
  getSettingsSections(page?: SettingsSectionPage): Array<Owned<SettingsSectionContribution>> {
    const sections = this.sorted("settings-sections", this.#settingsSections);
    return page === undefined ? sections : sections.filter((section) => section.page === page);
  }

  /** The section that took over the page `pageId` (its `replaces`), when no page of that id is registered. */
  settingsSectionReplacing(pageId: string): Owned<SettingsSectionContribution> | undefined {
    if (this.#settingsPages.has(pageId)) return undefined;
    return this.sorted("settings-sections", this.#settingsSections).find((section) => section.replaces?.includes(pageId));
  }

  /** The page a section took over `pageId` for (its `replaces`), when no page of that id is registered. */
  settingsPageReplacedBy(pageId: string): SettingsSectionPage | undefined {
    return this.settingsSectionReplacing(pageId)?.page;
  }

  /** Every extension's row states by thread id; the same object until one changes. */
  getThreadRowMarks = (): Readonly<Record<string, ThreadRowMark<ReactNode>>> => {
    if (this.#mergedRowMarks?.version !== (this.#dataVersions.get("marks") ?? 0)) {
      this.#mergedRowMarks = { version: this.#dataVersions.get("marks") ?? 0, marks: Object.assign({}, ...this.#rowMarks.values()) as Record<string, ThreadRowMark<ReactNode>> };
    }
    return this.#mergedRowMarks.marks;
  };

  /** The waiting label an extension set for a thread, if any. */
  getLiveStatus(sessionId: string | undefined): string | undefined {
    if (!sessionId) return undefined;
    for (const own of this.#liveStatuses.values()) {
      const label = own.get(sessionId);
      if (label !== undefined) return label;
    }
    return undefined;
  }

  /** What the active extensions reported as wrong, in activation order. */
  getProblems(): Array<ExtensionProblem & ContributionOwner> {
    return this.#problemCache ??= [...this.#problems.values()].flat();
  }

  /** Published pictures take precedence over the saved choice, even without a Workspace interface. */
  projectIcon(project: { workspaceId?: string | undefined; path: string }): string | undefined {
    for (const icons of this.#projectIcons.values()) {
      const icon = (project.workspaceId ? icons[project.workspaceId] : undefined) ?? icons[project.path];
      if (icon) return icon;
    }
    return readProjectIcon(this.services.preferences, project)?.image;
  }

  /** The picture an extension chose for a model provider, if any (`setProviderIcons`). */
  providerIcon(provider: string): string | undefined {
    if (this.#providerIcons.size === 0) return undefined;
    const key = providerIconKey(provider);
    for (const icons of this.#providerIcons.values()) if (icons[key]) return icons[key];
    return undefined;
  }

  /** Lineage of every extension, merged into one map the navigator can read. */
  getThreadLineage(): ThreadLineage {
    if (this.#lineageCache?.version === (this.#dataVersions.get("lineage") ?? 0)) return this.#lineageCache.value;
    const value: ThreadLineage = this.#lineages.size === 0
      ? EMPTY_THREAD_LINEAGE
      : [...this.#lineages.values()].reduce((merged, lineage) => ({
        parents: { ...lineage.parents, ...merged.parents },
        workingChildren: { ...lineage.workingChildren, ...merged.workingChildren },
      }), EMPTY_THREAD_LINEAGE);
    this.#lineageCache = { version: this.#dataVersions.get("lineage") ?? 0, value };
    return value;
  }

  /** Rows every extension published for one thread, sorted by source order; ids are namespaced by source. */
  getTranscriptRows(sessionId: string | undefined): TranscriptRow[] {
    if (!sessionId) return this.#emptyTranscriptRows;
    const cached = this.#transcriptCache.get(sessionId);
    if (cached) return cached;
    const value = [...this.#transcriptRows.entries()]
      .sort(([, a], [, b]) => a.order - b.order)
      .flatMap(([id, source]) => (source.bySession.get(sessionId) ?? []).map((row) => ({ ...row, id: `${id}:${row.id}` })));
    this.#transcriptCache.set(sessionId, value);
    return value;
  }

  getRegions(placement: RegionPlacement | SlotPlacement): Array<Owned<RegionContribution>> {
    const key = `regions:placed:${placement}`;
    const cached = this.#sortedCache.get(key);
    if (cached?.version === this.#version) return cached.value as Array<Owned<RegionContribution>>;
    const value = this.customized("region", this.#regions).filter((region) => region.placement === placement);
    this.#sortedCache.set(key, { version: this.#version, value });
    return value;
  }

  getStatusItems(): Array<Owned<StatusItemContribution>> {
    return this.customized("status", this.#statusItems);
  }

  getOverlay(id: string | undefined): Owned<OverlayContribution> | undefined {
    return id ? this.#overlays.get(id) : undefined;
  }

  getConversationView(id: string | undefined): Owned<ConversationViewContribution> | undefined {
    return id ? this.#conversationViews.get(id) : undefined;
  }

  /** Forwards one core event to the extensions listening for its type. */
  dispatchWorkbenchEvent(event: WorkbenchEvent): void {
    const listeners = this.#workbenchEventListeners.get(event.type);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event); } catch (error) { console.error(`Extension listener for ${event.type} failed`, error); }
    }
  }

  getComposerControls(): Array<Owned<ComposerControlContribution>> {
    return this.customized("composer-control", this.#composerControls);
  }

  getComposerInlines(): Array<Owned<ComposerInlineContribution>> {
    return this.sorted("composer-inlines", this.#composerInlines, false);
  }

  getComposerGates(): Array<Owned<ComposerGateContribution>> {
    return this.sorted("composer-gates", this.#composerGates);
  }

  getModelBadges(): Array<Owned<ModelBadgeContribution>> {
    return this.sorted("model-badges", this.#modelBadges);
  }

  getComposerSpeeds(): Array<Owned<ComposerSpeedContribution>> {
    return this.sorted("composer-speeds", this.#composerSpeeds);
  }

  getComposerSendModes(): Array<Owned<ComposerSendModeContribution>> {
    return this.sorted("composer-send-modes", this.#composerSendModes);
  }

  getComposerPlanners(): Array<Owned<ComposerPlannerContribution>> {
    return this.sorted("composer-planners", this.#composerPlanners);
  }

  getSidebarContributions(): Array<Owned<SidebarContribution>> {
    return this.customized("sidebar", this.#sidebarContributions);
  }

  getProjectSources(): Array<Owned<ProjectSourceContribution>> {
    return this.sorted("sources", this.#projectSources);
  }

  getThreadListSources(): Array<Owned<ThreadListSource>> {
    return this.sorted("thread-list-sources", this.#threadListSources, false);
  }

  getThreadListAccessories(): Array<Owned<ThreadListAccessoryContribution>> {
    return this.sorted("thread-list-accessories", this.#threadListAccessories, false);
  }

  getThreadListLayouts(): Array<Owned<ThreadListLayout>> {
    return this.sorted("thread-list-layouts", this.#threadListLayouts, false);
  }

  getCommands(): Array<Owned<CommandContribution>> {
    const cached = this.#sortedCache.get("commands:listed");
    if (cached?.version === this.#version) return cached.value as Array<Owned<CommandContribution>>;
    // A command that a registered command's binding `replaces` is its stand-in; listing both would show one action twice.
    const standIns = this.keybindings.standIns((id) => this.#commands.has(id));
    const value = this.sorted("commands", this.#commands, false).filter((command) => !standIns.has(command.id));
    this.#sortedCache.set("commands:listed", { version: this.#version, value });
    return value;
  }

  /** Visible keyboard areas, in `order`. */
  getFocusAreas(): readonly FocusAreaContribution[] { return this.sorted("focus areas", this.#focusAreas); }

  /** The palette's sources, in `order`. */
  getPaletteSources(): Array<Owned<PaletteSourceContribution>> {
    return this.sorted("palette-sources", this.#paletteSources);
  }

  getCommandsFor(surface: CommandSurface): Array<Owned<CommandContribution>> {
    const key = `commands:${surface}`;
    const cached = this.#sortedCache.get(key);
    if (cached?.version === this.#version) return cached.value as Array<Owned<CommandContribution>>;
    const value = this.getCommands().filter((command) => command.surfaces?.includes(surface));
    this.#sortedCache.set(key, { version: this.#version, value });
    return value;
  }

  applyKeybindingOverrides(overrides?: Record<string, string>): void {
    this.keybindings.applyKeybindingOverrides(overrides);
  }

  getKeybindings(): ResolvedKeybinding[] { return this.keybindings.getKeybindings(); }
  getKeybindingConflicts(mac?: boolean): readonly KeybindingConflict[] { return this.keybindings.getKeybindingConflicts(mac); }
  getDefaultKeybindings(commandId: string): ResolvedKeybinding[] { return this.keybindings.getDefaultKeybindings(commandId); }
  findKeybindingCollisions(candidate: UserKeybinding & { commandId: string }, mac?: boolean): KeybindingCollision[] {
    return this.keybindings.findKeybindingCollisions(candidate, mac);
  }
  keybindingLabel(commandId: string): string | undefined { return this.keybindings.keybindingLabel(commandId); }

  matchKeybinding(event: KeyboardEvent, page: (name: string) => boolean = domKeybindingContext()): { command: Owned<CommandContribution>; binding: ResolvedKeybinding; modified: boolean; specific: boolean } | undefined {
    const match = this.keybindings.matchKeybinding(event, page);
    const command = match && this.#commands.get(match.binding.commandId);
    return match && command ? { ...match, command } : undefined;
  }

  /** Where recorded chords are written, from the extension that registered last. */
  getUserKeymap(): Owned<UserKeymapContribution> | undefined {
    return [...this.#userKeymaps.values()].at(-1);
  }

  /** Finds a registered command by its ID, if any. */
  getCommand(id: string): Owned<CommandContribution> | undefined {
    return this.#commands.get(id);
  }

  /** Executes a command registered with `registerCommand`. */
  async executeCommand(id: string, actions: WorkbenchActions): Promise<void> {
    const command = this.#commands.get(id);
    if (!command) throw new Error(`Command "${id}" is not registered.`);
    await command.run(actions);
  }

  getSlashCommands(): Array<Owned<SlashCommandContribution>> {
    return this.sorted("slash-commands", this.#slashCommands, false);
  }

  /** Splits `/name rest` and finds the desktop command for it, if any. */
  findSlashCommand(text: string): { command: Owned<SlashCommandContribution>; args: string } | undefined {
    const match = /^\/([^\s]+)(?:\s+([^]*))?$/u.exec(text.trim());
    if (!match) return undefined;
    const command = this.#slashCommands.get(match[1]!);
    return command ? { command, args: (match[2] ?? "").trim() } : undefined;
  }

  getPromptRenderer(prompt: ExtensionUiPrompt): Owned<PromptRendererContribution> | undefined {
    for (const renderer of this.#promptRenderers.values()) if (renderer.match(prompt)) return renderer;
    return undefined;
  }

  /** An answer a renderer already knows for this prompt, if any. */
  interceptPrompt(prompt: ExtensionUiPrompt): ExtensionUiAnswer | undefined {
    const renderer = this.getPromptRenderer(prompt);
    try {
      return renderer?.intercept?.(prompt);
    } catch (error) {
      console.error(`Prompt renderer ${renderer?.id} failed to intercept`, error);
      return undefined;
    }
  }

  notifyPromptAnswered(prompt: ExtensionUiPrompt, answer: ExtensionUiAnswer): void {
    const renderer = this.getPromptRenderer(prompt);
    try {
      renderer?.onAnswered?.(prompt, answer);
    } catch (error) {
      console.error(`Prompt renderer ${renderer?.id} failed on answer`, error);
    }
  }

  getDocumentSource(): Owned<DocumentSourceContribution> | undefined {
    return this.sorted("documents", this.#documentSources)[0];
  }

  getExtensionSummaries(): ExtensionSummary[] {
    return [...this.#known.values()].map((extension) => ({
      id: extension.id,
      name: extension.name,
      active: this.#activeExtensions.has(extension.id),
      contributes: (this.#contributionKinds.get(extension.id) ?? []).join(" · "),
      options: this.#options.get(extension.id) ?? [],
      permissions: extension.permissions,
      granted: extension.granted,
      ...(this.#coreIds.has(extension.id) ? { core: true } : {}),
    }));
  }

  /**
   * Asks every gate about a thread that is about to be created, in registration
   * order; the first workspace named, or the first `stop`, wins. A gate that
   * throws is reported and skipped: the prompt still goes to the project the
   * draft already has.
   */
  async prepareNewThread(event: NewThreadPromptEvent, actions: WorkbenchActions): Promise<NewThreadPromptGate | undefined> {
    for (const hook of this.#promptHooks.values()) {
      if (!hook.beforeNewThread) continue;
      try {
        const result = await hook.beforeNewThread(event, actions);
        if (result?.workspace || result?.stop) return result;
      } catch (error) {
        actions.notify(`${hook.extensionName}: ${errorMessage(error)}`, "error");
      }
    }
    return undefined;
  }

  /**
   * Offers a new thread's first prompt to every hook that may start it itself,
   * in registration order; the first that answers `true` has taken it.
   */
  async claimNewThread(event: NewThreadClaimEvent, actions: WorkbenchActions): Promise<boolean> {
    for (const hook of this.#promptHooks.values()) {
      if (!hook.claimNewThread) continue;
      // Claims run in order; a rejection must keep the draft out of later hooks.
      // oxlint-disable-next-line no-await-in-loop
      if (await hook.claimNewThread(event, actions)) return true;
    }
    return false;
  }

  /** The model set a new thread's picker builds, from the extension that registered last. */
  getModelSelection(): Owned<ModelSelectionContribution> | undefined {
    return [...this.#modelSelections.values()].at(-1);
  }

  getTranscriptFinder(): Owned<TranscriptFinderContribution> | undefined {
    return [...this.#transcriptFinders.values()].at(-1);
  }

  getThreadMenu(): Owned<ThreadMenuContribution> | undefined {
    return [...this.#threadMenus.values()].at(-1);
  }

  getForkPrompt(): Owned<ForkPromptContribution> | undefined {
    return [...this.#forkPrompts.values()].at(-1);
  }

  streamingDelivery(): "followUp" | "steer" | undefined {
    for (const hook of this.#promptHooks.values()) {
      const delivery = hook.streamingDelivery?.();
      if (delivery) return delivery;
    }
    return undefined;
  }

  getMessageActions(): Array<Owned<MessageActionContribution>> {
    return this.sorted("message-actions", this.#messageActions, false);
  }

  getMessageBlocks(): Array<Owned<MessageBlockContribution>> {
    return this.sorted("message-blocks", this.#messageBlocks, false);
  }

  async notifyPromptSubmitted(event: PromptSubmittedEvent, actions: WorkbenchActions): Promise<void> {
    this.dispatchWorkbenchEvent({ type: "prompt-accepted" });
    for (const hook of this.#promptHooks.values()) {
      try {
        await hook.afterPrompt?.(event, actions);
      } catch (error) {
        actions.notify(`${hook.extensionName}: ${errorMessage(error)}`, "error");
      }
    }
  }

  /** Routes a host extension event to the desktop entry that subscribed to it. */
  dispatchExtensionEvent(event: ExtensionEvent): void {
    const listeners = this.#hostEventListeners.get(event.extensionId)?.get(event.name);
    if (!listeners) return;
    for (const listener of [...listeners]) {
      try { listener(event.payload); } catch (error) { console.error(`Extension ${event.extensionId} event handler failed`, error); }
    }
  }

  getExtensionNames(): string[] {
    return [...this.#activeExtensions.values()].map(({ extension }) => extension.name);
  }

  /** The card that draws this tool, when one claimed it. */
  toolCardFor(tool: UiToolRun): Owned<ToolCardContribution> | undefined {
    for (const card of this.#toolCards.values()) {
      if (card.match(tool)) return card;
    }
    return undefined;
  }

  toolCard(id: string): Owned<ToolCardContribution> | undefined {
    return this.#toolCards.get(id);
  }

  presentTool(tool: UiToolRun): ToolPresentation {
    for (const renderer of this.#renderers.values()) {
      if (renderer.match(tool)) return renderer.render(tool);
    }
    return {
      glyph: "◇",
      title: tool.name,
      tone: "neutral",
      detail: toolArgumentSummary(tool.args),
    };
  }

  /**
   * Why an extension's module could not be built or imported the last time it
   * was tried, by the path it was tried from. The extension that was already
   * running keeps running; this is what the Inspector shows instead of it
   * silently being one version behind.
   */
  noteLoadFailure(path: string, message: string | undefined): void {
    if (message === undefined) {
      if (!this.#loadFailures.delete(path)) return;
    } else {
      if (this.#loadFailures.get(path) === message) return;
      this.#loadFailures.set(path, message);
    }
    this.changed();
  }

  /**
   * Whether the packages of this client are still on their way (the first
   * load of a workspace's set); a page no package registered yet may still come.
   */
  isLoadingExtensions(): boolean {
    return this.#loadingExtensions;
  }

  /** All active URL stylesheets currently in the document, loaded or failed. */
  async whenStylesReady(): Promise<void> {
    await Promise.all([...document.head.querySelectorAll<HTMLLinkElement>("link[data-tau-extension]")]
      .map((link) => stylesheetLoads.get(link)));
  }

  setLoadingExtensions(loading: boolean): void {
    if (this.#loadingExtensions === loading) return;
    this.#loadingExtensions = loading;
    this.changed();
  }

  getLoadFailures(): Array<{ path: string; message: string }> {
    return [...this.#loadFailures].map(([path, message]) => ({ path, message }));
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  /** Cheap identity for useSyncExternalStore — changes whenever contributions change. */
  getVersion = (): number => this.#legacyVersion;

  /** Static contributions and lifecycle changes, independent of extension data. */
  getRegistrationVersion = (): number => this.#version;
  subscribeRegistrations = (listener: () => void): (() => void) => {
    this.#registrationListeners.add(listener);
    return () => this.#registrationListeners.delete(listener);
  };

  /** Dynamic data belongs to a domain, or to one thread's transcript and status. */
  subscribeData = (key: string, listener: () => void): (() => void) => {
    const listeners = this.#dataListeners.get(key) ?? new Set<() => void>();
    this.#dataListeners.set(key, listeners);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.#dataListeners.delete(key);
    };
  };
  getDataVersion = (key: string): number => this.#dataVersions.get(key) ?? 0;

  subscribeMarks = (listener: () => void) => this.subscribeData("marks", listener);
  subscribeProjectIcons = (listener: () => void): (() => void) => {
    const stopData = this.subscribeData("project-icons", listener);
    const stopPreferences = this.services.preferences.subscribe(listener);
    return () => { stopData(); stopPreferences(); };
  };
  subscribeProviderIcons = (listener: () => void) => this.subscribeData("provider-icons", listener);

  private dataChanged(key: string, transcript = false): void {
    this.#dataVersions.set(key, this.getDataVersion(key) + 1);
    if (key === "problems") this.#problemCache = undefined;
    if (transcript && key.startsWith("thread:")) this.#transcriptCache.delete(key.slice(7));
    this.#legacyVersion += 1;
    runAll([...(this.#dataListeners.get(key) ?? []), ...this.#listeners]);
  }

  private register<T>(map: Map<string, T>, id: string, value: T, activation: ExtensionActivation): () => void {
    if (!activation.active) return noContribution;
    const existing = map.get(id) as (T & Partial<ContributionOwner>) | undefined;
    const incoming = value as T & Partial<ContributionOwner>;
    if (existing) {
      throw new Error(`Contribution id ${id} from ${incoming.extensionId ?? "unknown"} collides with ${existing.extensionId ?? "another extension"}`);
    }
    map.set(id, value);
    const dispose = () => {
      if (map.get(id) === value) map.delete(id);
      this.changed();
    };
    const release = activation.own(dispose);
    this.changed();
    return release;
  }

  private sorted<T>(
    key: string,
    map: Map<string, T>,
    byOrder = true,
  ): T[] {
    const cached = this.#sortedCache.get(key);
    if (cached?.version === this.#version) return cached.value as T[];
    const value = [...map.values()];
    if (byOrder) value.sort((a, b) =>
      ((a as { order?: number }).order ?? 0) - ((b as { order?: number }).order ?? 0),
    );
    this.#sortedCache.set(key, { version: this.#version, value });
    return value;
  }

  /** A kind's contributions as the user customized them, in their (possibly overridden) order. */
  private customized<T extends { id: string; order?: number }>(kind: PartKind, map: Map<string, T>): T[] {
    const key = `customized:${kind}`;
    const cached = this.#sortedCache.get(key);
    if (cached?.version === this.#version) return cached.value as T[];
    const value = this.#customization.apply(kind, [...map.values()]);
    this.#sortedCache.set(key, { version: this.#version, value });
    return value;
  }

  /** Every part on offer on this client, including contributions another profile draws. */
  getCustomizableParts(): CustomizablePart[] {
    return this.#customization.parts([
      { kind: "region", items: this.#regions.values() },
      { kind: "status", items: this.#statusItems.values() },
      { kind: "panel", items: this.#panels.values() },
      { kind: "page", items: this.#pages.values() },
      { kind: "sidebar", items: this.#sidebarContributions.values() },
      { kind: "composer-control", items: this.#composerControls.values() },
    ], this.getUnrenderedContributions());
  }

  private changed(): void {
    this.#version += 1;
    this.#legacyVersion += 1;
    runAll([...this.#registrationListeners, ...this.#listeners]);
  }
}
