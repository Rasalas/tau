/**
 * Where Settings' pages sit in its navigation, and how a link names a place
 * in Settings. Pure, so the order and the links are tested without the screen.
 */

/** The groups of the navigation, in order; a page names its group, a page without one is an extension's. */
export type SettingsNavGroup = "general" | "threads" | "projects" | "remote" | "extensions" | "diagnostics";

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{ id: SettingsNavGroup; label: string; folds?: boolean }> = [
  // The pages most people come for stay open; the rest fold (design 1j lists eight).
  { id: "general", label: "Settings" },
  { id: "threads", label: "Threads", folds: true },
  { id: "projects", label: "Projects", folds: true },
  { id: "remote", label: "Remote", folds: true },
  { id: "extensions", label: "Extensions", folds: true },
  { id: "diagnostics", label: "Diagnostics", folds: true },
];

export function isSettingsNavGroup(value: unknown): value is SettingsNavGroup {
  return SETTINGS_NAV_GROUPS.some((group) => group.id === value);
}

/** Core's own pages: their place among the pages kits add to the same groups. */
export const CORE_SETTINGS_PAGES = [
  { id: "general", label: "General", group: "general", order: 0 },
  { id: "models", label: "Models", group: "general", order: 10 },
  { id: "providers", label: "Providers", group: "general", order: 20 },
  { id: "runtimes", label: "Runtimes", group: "general", order: 30 },
  { id: "keybindings", label: "Keybindings", group: "general", order: 80 },
  { id: "connections", label: "Connections", group: "general", order: 90 },
  { id: "pi", label: "Pi", group: "threads", order: 20 },
  { id: "extensions", label: "All extensions", group: "extensions", order: 0 },
  { id: "inspector", label: "Inspector", group: "diagnostics", order: 50 },
] as const satisfies ReadonlyArray<{ id: string; label: string; group: SettingsNavGroup; order: number }>;

export type CoreSettingsPage = (typeof CORE_SETTINGS_PAGES)[number]["id"] | "about";

/** The title a core page carries in the bar and the search. */
export const CORE_PAGE_TITLES: Readonly<Record<CoreSettingsPage, string>> = {
  general: "General",
  keybindings: "Keybindings",
  models: "Models",
  providers: "Providers",
  runtimes: "Runtimes",
  pi: "Pi",
  connections: "Connections",
  extensions: "Extensions",
  inspector: "Inspector",
  about: "About",
};

/** What a core page governs, in one sentence under its title; the search finds it too. */
export const CORE_PAGE_DESCRIPTIONS: Readonly<Record<CoreSettingsPage, string>> = {
  general: "How the transcript and the composer behave, and how Tau runs in the background and quits.",
  keybindings: "The keys for the workbench's commands and Pi's actions, and where each of them applies.",
  models: "What a new thread starts with: its model and how hard it thinks, and what Pi samples with.",
  providers: "Who each runtime is signed in as and the providers it reaches, where its program lives, and the models it offers.",
  runtimes: "A runtime is the program that runs a thread, with its own tools, approvals and sessions; providers are what it talks to. The composer picks one per thread.",
  pi: "Pi's own settings, shared with the Pi CLI. A change applies to the next thread Tau starts; a running one keeps what it began with.",
  connections: "Devices that talk to this machine directly, and the tools threads hand off to. Pairing uses a code you compare on both sides.",
  extensions: "Everything that adds to Tau, bundled or installed. Turn one on or off, approve what it asks for, or open its page.",
  inspector: "Every extension both halves know and the package folders on disk, to find out why something did not load.",
  about: "The version of Tau on this machine, its updates and the licences of the software it ships.",
};

export interface SettingsNavItem {
  id: string;
  label: string;
  group?: SettingsNavGroup | undefined;
  order?: number | undefined;
}

/** The navigation's groups with their pages, each group in `order` and then as given; empty groups are left out. */
export function settingsNavGroups<T extends SettingsNavItem>(items: readonly T[]): Array<{ id: SettingsNavGroup; label: string; folds?: boolean; items: T[] }> {
  return SETTINGS_NAV_GROUPS.flatMap((group) => {
    const members = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => (item.group ?? "extensions") === group.id)
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

/** Page ids older links still use. */
const RENAMED: Readonly<Record<string, string>> = { defaults: "general" };

/**
 * A place in Settings, as `openSettings` and a phone's `?settings=` name it:
 * a page id, optionally `#` and the id of a row on it — `general#setting-show-costs`,
 * `extensions/tau.terminal`, `models#setting-thinking-level`.
 */
export function parseSettingsTarget(target: string | undefined): { page: string; anchor?: string } {
  const [rawPage = "", anchor] = (target ?? "").split("#", 2);
  const page = RENAMED[rawPage] ?? (rawPage || "general");
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
