/**
 * Where Settings' pages sit in its navigation, and how a link names a place
 * in Settings. Pure, so the order and the links are tested without the screen.
 */

/**
 * The groups of the navigation, in order. A page names its group; one that names
 * none sits in App, after the pages core keeps there. `diagnostics` is not a
 * heading: its pages stand above About Tau at the foot of the column.
 */
export type SettingsNavGroup = "app" | "agents" | "projects" | "tools" | "machines" | "diagnostics";

/** The names of a group before API 1.61.0; a page that still uses one is placed in the group it became. */
export type SettingsNavGroupAlias = "general" | "threads" | "remote" | "extensions";

const GROUP_ALIASES: Readonly<Record<SettingsNavGroupAlias, SettingsNavGroup>> = { general: "app", threads: "agents", remote: "machines", extensions: "app" };

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{ id: SettingsNavGroup; label: string; folds?: boolean }> = [
  // What most people come for stays open; the rest fold.
  { id: "app", label: "App" },
  { id: "agents", label: "Agents" },
  { id: "projects", label: "Projects", folds: true },
  { id: "tools", label: "Tools", folds: true },
  { id: "machines", label: "Machines", folds: true },
  { id: "diagnostics", label: "Diagnostics" },
];

export function isSettingsNavGroup(value: unknown): value is SettingsNavGroup | SettingsNavGroupAlias {
  return SETTINGS_NAV_GROUPS.some((group) => group.id === value) || (typeof value === "string" && Object.hasOwn(GROUP_ALIASES, value));
}

/** The group a page's `group` names; a page without one is in App. */
export function navGroupOf(name: SettingsNavGroup | SettingsNavGroupAlias | undefined): SettingsNavGroup {
  if (name === undefined) return "app";
  return Object.hasOwn(GROUP_ALIASES, name) ? GROUP_ALIASES[name as SettingsNavGroupAlias] : name as SettingsNavGroup;
}

/** Core's own pages: their place among the pages kits add to the same groups. */
export const CORE_SETTINGS_PAGES = [
  { id: "general", label: "General", group: "app", order: 0 },
  { id: "keybindings", label: "Keybindings", group: "app", order: 80 },
  { id: "extensions", label: "Extensions", group: "app", order: 90 },
  { id: "runtimes", label: "Runtimes", group: "agents", order: 0 },
  { id: "threads", label: "Threads", group: "agents", order: 10 },
  { id: "connections", label: "Connections", group: "machines", order: 90 },
  { id: "inspector", label: "Diagnostics", group: "diagnostics", order: 0 },
] as const satisfies ReadonlyArray<{ id: string; label: string; group: SettingsNavGroup; order: number }>;

export type CoreSettingsPage = (typeof CORE_SETTINGS_PAGES)[number]["id"] | "about";

/** The title a core page carries in the bar and the search. */
export const CORE_PAGE_TITLES: Readonly<Record<CoreSettingsPage, string>> = {
  general: "General",
  keybindings: "Keybindings",
  runtimes: "Runtimes",
  threads: "Threads",
  connections: "Connections",
  extensions: "Extensions",
  inspector: "Diagnostics",
  about: "About",
};

/** What a core page governs, in one sentence under its title; the search finds it too. */
export const CORE_PAGE_DESCRIPTIONS: Readonly<Record<CoreSettingsPage, string>> = {
  general: "How the composer and the transcript behave, and how Tau quits.",
  keybindings: "Shortcuts follow the layer you are in: the app, the conversation, the stage. Conflicts are shown as you type.",
  runtimes: "A runtime is the program that runs a thread, with its own sign-in, models and tools. The star marks where a new thread starts; the composer can still pick another per thread.",
  threads: "Where a new thread starts, and how a thread behaves while it runs and after a restart.",
  connections: "Devices that talk to this machine directly, and the tools threads hand off to. Pairing uses a code you compare on both sides.",
  extensions: "Everything that adds to Tau, bundled or installed. Turn one on or off, approve what it asks for, or open its page.",
  inspector: "Every extension both halves know and the package folders on disk, to find out why something did not load.",
  about: "The version of Tau on this machine, its updates and the licences of the software it ships.",
};

export interface SettingsNavItem {
  id: string;
  label: string;
  group?: SettingsNavGroup | SettingsNavGroupAlias | undefined;
  order?: number | undefined;
}

/** The navigation's groups with their pages, each group in `order` and then as given; empty groups are left out. */
export function settingsNavGroups<T extends SettingsNavItem>(items: readonly T[]): Array<{ id: SettingsNavGroup; label: string; folds?: boolean; items: T[] }> {
  return SETTINGS_NAV_GROUPS.flatMap((group) => {
    const members = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => navGroupOf(item.group) === group.id)
      .sort((left, right) => (left.item.order ?? 100) - (right.item.order ?? 100) || left.index - right.index)
      .map(({ item }) => item);
    return members.length ? [{ ...group, items: members }] : [];
  });
}

/**
 * Whether a group shows its pages: one that does not fold always; one that
 * folds as the user left it, else open while it holds the page on screen.
 */
export function settingsNavGroupOpen(group: { id: SettingsNavGroup; folds?: boolean; items: readonly { id: string }[] }, active: string, toggled: Readonly<Partial<Record<SettingsNavGroup, boolean>>>): boolean {
  if (!group.folds) return true;
  return toggled[group.id] ?? group.items.some((item) => item.id === active);
}

/** An extension's own page: `extensions/<id>`. */
export const EXTENSION_PAGE_PREFIX = "extensions/";

export function extensionPage(id: string): string {
  return `${EXTENSION_PAGE_PREFIX}${id}`;
}

export function extensionOfPage(page: string): string | undefined {
  return page.startsWith(EXTENSION_PAGE_PREFIX) ? page.slice(EXTENSION_PAGE_PREFIX.length) || undefined : undefined;
}

/** A runtime on the Runtimes page: `runtimes/<kind>`, under the list of runtimes (API 1.61.0). */
export const RUNTIME_PAGE_PREFIX = "runtimes/";

export function runtimePage(kind: string): string {
  return `${RUNTIME_PAGE_PREFIX}${kind}`;
}

export function runtimeOfPage(page: string): string | undefined {
  return page.startsWith(RUNTIME_PAGE_PREFIX) ? page.slice(RUNTIME_PAGE_PREFIX.length) || undefined : undefined;
}

/** Page ids older links still use. */
const RENAMED: Readonly<Record<string, string>> = { defaults: "general" };

/** Pages that became part of Runtimes (API 1.61.0): Pi's and the model settings are Pi's entry there; a kit's card has its runtime's. */
const MERGED_PAGES: Readonly<Record<string, string>> = { models: runtimePage("pi"), pi: runtimePage("pi"), providers: "runtimes" };

/** Rows whose title, and so their id, changed when their page was merged or cleaned up. */
const RENAMED_ANCHORS: Readonly<Record<string, string>> = {
  "setting-startup-model": "setting-default-model",
  "setting-startup-thinking-level": "setting-default-thinking",
  "setting-thinking-level": "setting-default-thinking",
  "setting-reserve-tokens": "setting-room-for-the-reply",
  "setting-keep-recent-tokens": "setting-keep-recent",
  "setting-max-retries": "setting-retries",
  "setting-base-delay": "setting-first-wait",
  "setting-terminal-command": "setting-command-line",
  "setting-rotate-the-host-token": "setting-rotate-the-access-key",
  "setting-appearance-terminal-font": "setting-terminal-font",
};

/** Rows that left the page a link names for another one: where a link to one now lands (API 1.61.0). */
const MOVED_ROWS: Readonly<Record<string, { from: string; page: string }>> = {
  "setting-run-on": { from: "general", page: "threads" },
  "setting-new-thread-workspace": { from: "general", page: "threads" },
  "setting-branch-name": { from: "general", page: "threads" },
  "setting-settle-automatically": { from: "general", page: "threads" },
  "setting-compact-context": { from: "general", page: "threads" },
  "setting-continue-threads-after-restarts": { from: "general", page: "threads" },
  "setting-wakes-during-a-turn": { from: "general", page: "threads" },
  "setting-keep-tau-running-in-the-background": { from: "general", page: "connections" },
  "setting-command-line": { from: "general", page: "connections" },
  "setting-terminal-font": { from: "appearance", page: "terminal.settings" },
};

/**
 * A place in Settings, as `openSettings` and a phone's `?settings=` name it:
 * a page id, optionally `#` and the id of a row on it — `general#setting-show-costs`,
 * `extensions/tau.terminal`, `runtimes/pi#setting-default-thinking`. The older
 * `models`, `pi` and `providers` land on Runtimes, and `providers#runtime-models-<kind>` on that runtime.
 */
export function parseSettingsTarget(target: string | undefined): { page: string; anchor?: string } {
  const [rawPage = "", rawAnchor] = (target ?? "").split("#", 2);
  const anchor = rawAnchor === undefined ? undefined : RENAMED_ANCHORS[rawAnchor] ?? rawAnchor;
  const named = RENAMED[rawPage] ?? (rawPage || "general");
  const modelsOf = named === "providers" ? /^runtime-models-(.+)$/u.exec(anchor ?? "")?.[1] : undefined;
  const merged = modelsOf ? runtimePage(modelsOf) : Object.hasOwn(MERGED_PAGES, named) ? MERGED_PAGES[named]! : named;
  const moved = anchor !== undefined && Object.hasOwn(MOVED_ROWS, anchor) ? MOVED_ROWS[anchor]! : undefined;
  const page = moved?.from === merged ? moved.page : merged;
  return anchor ? { page, anchor } : { page };
}

export function settingsTarget(page: string, anchor?: string): string {
  return anchor ? `${page}#${anchor}` : page;
}

/** The page a page belongs under in the bar and a phone's history: an extension's, the list of extensions. */
export function parentSettingsPage(page: string): string | undefined {
  const slash = page.indexOf("/");
  return slash > 0 ? page.slice(0, slash) : undefined;
}
