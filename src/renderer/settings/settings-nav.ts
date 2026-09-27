/**
 * Where Settings' pages sit in its navigation, and how a link names a place
 * in Settings. Pure, so the order and the links are tested without the screen.
 */

/** The groups of the navigation, in order; a page names its group, a page without one is an extension's. */
export type SettingsNavGroup = "general" | "threads" | "projects" | "remote" | "extensions" | "diagnostics";

export const SETTINGS_NAV_GROUPS: ReadonlyArray<{ id: SettingsNavGroup; label?: string }> = [
  // The first group has no heading: the pages most people come for.
  { id: "general" },
  { id: "threads", label: "Threads" },
  { id: "projects", label: "Projects" },
  { id: "remote", label: "Remote" },
  { id: "extensions", label: "Extensions" },
  { id: "diagnostics", label: "Diagnostics" },
];

export function isSettingsNavGroup(value: unknown): value is SettingsNavGroup {
  return SETTINGS_NAV_GROUPS.some((group) => group.id === value);
}

/** Core's own pages: their place among the pages kits add to the same groups. */
export const CORE_SETTINGS_PAGES = [
  { id: "general", label: "General", group: "general", order: 0 },
  { id: "keybindings", label: "Keybindings", group: "general", order: 80 },
  { id: "models", label: "Models", group: "threads", order: 0 },
  { id: "providers", label: "Providers", group: "threads", order: 10 },
  { id: "pi", label: "Pi", group: "threads", order: 20 },
  { id: "connections", label: "Connections", group: "remote", order: 0 },
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
  pi: "Pi",
  connections: "Connections",
  extensions: "Extensions",
  inspector: "Inspector",
  about: "About",
};

export interface SettingsNavItem {
  id: string;
  label: string;
  group?: SettingsNavGroup | undefined;
  order?: number | undefined;
}

/** The navigation's groups with their pages, each group in `order` and then as given; empty groups are left out. */
export function settingsNavGroups<T extends SettingsNavItem>(items: readonly T[]): Array<{ id: SettingsNavGroup; label?: string; items: T[] }> {
  return SETTINGS_NAV_GROUPS.flatMap((group) => {
    const members = items
      .map((item, index) => ({ item, index }))
      .filter(({ item }) => (item.group ?? "extensions") === group.id)
      .sort((left, right) => (left.item.order ?? 100) - (right.item.order ?? 100) || left.index - right.index)
      .map(({ item }) => item);
    return members.length ? [{ ...group, items: members }] : [];
  });
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
