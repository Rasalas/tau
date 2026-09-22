/**
 * What the Settings search finds: core's own rows with the words people use
 * for them, the pages extensions contributed with their keywords, each
 * extension's own page and every keybinding. Pure, so the ranking is tested
 * without the modal; the palette reads the same entries.
 */
export interface SettingsSearchEntry {
  id: string;
  /** The Settings page the entry opens. */
  page: string;
  label: string;
  /** The page it lives on, shown beside the label. */
  section: string;
  keywords: readonly string[];
  /** For a keybinding: what the Keybindings page is filtered to. */
  filter?: string;
  /** Ranks after every other match: a keybinding mirrors a row somewhere else. */
  secondary?: boolean;
  /** The id of the row on its page, which the page scrolls to. */
  target?: string;
}

/** The element id of a core row, from its label: what a search result scrolls to. */
export function settingAnchor(label: string): string {
  return `setting-${label.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "")}`;
}

type CoreRow = readonly [label: string, keywords: readonly string[]];

const CORE_PAGES: ReadonlyArray<{ page: string; label: string; keywords: readonly string[]; rows: readonly CoreRow[] }> = [
  {
    page: "defaults",
    label: "Defaults",
    keywords: ["general", "preferences", "new threads"],
    rows: [
      ["Default model", ["model", "provider", "add provider", "custom model"]],
      ["Thinking level", ["thinking", "reasoning", "effort"]],
      ["Runtime for new threads", ["runtime", "backend"]],
      ["Transcript detail", ["focused", "detailed", "everything", "tool output", "show thinking"]],
      ["Theme", ["appearance", "dark", "light", "system", "color", "colour"]],
      ["Show costs", ["cost", "money", "spend", "price"]],
      ["Keep the host running in the background", ["host", "background", "quit"]],
      ["Continue threads after restarts", ["restart", "resume", "interrupted"]],
      ["Composer editing mode", ["vim", "readline", "emacs", "modal"]],
      ["Send with", ["send", "enter", "submit", "shortcut"]],
      ["Model parameters", ["temperature", "max tokens", "sampling"]],
    ],
  },
  {
    page: "pi",
    label: "Pi",
    keywords: ["agent", "settings.json"],
    rows: [
      ["Write Pi settings to", ["global", "project", "scope", "settings.json"]],
      ["Startup model", ["default model", "thinking level"]],
      ["Compaction", ["compact", "reserve tokens", "keep recent tokens", "context"]],
      ["Retry", ["retries", "transient errors", "delay"]],
      ["Message delivery", ["steering", "follow-up", "queue"]],
      ["Built-in tools", ["tools", "read", "bash", "edit", "write"]],
      ["Shell", ["shell path", "command prefix", "npm command"]],
      ["Quiet startup", ["startup"]],
      ["Project trust", ["trust"]],
    ],
  },
  {
    page: "keybindings",
    label: "Keybindings",
    keywords: ["shortcuts", "chords", "keys", "keymap", "keybindings.json"],
    rows: [],
  },
  {
    page: "inspector",
    label: "Inspector",
    keywords: ["extensions", "packages", "versions", "system prompt", "problems", "debug"],
    rows: [],
  },
];

export interface SettingsSearchSources {
  /** Pages extensions contributed. */
  pages: ReadonlyArray<{ id: string; label: string; keywords?: readonly string[]; extensionName?: string }>;
  /** Every extension with a page of its own in the nav. */
  extensions: ReadonlyArray<{ id: string; name: string; core?: boolean; options?: ReadonlyArray<{ label: string }> }>;
  /** Live keybindings; leave out for a search that should find pages only. */
  keybindings?: ReadonlyArray<{ commandId: string; keys: string; label: string; commandLabel?: string }>;
}

export function settingsSearchEntries(sources: SettingsSearchSources): SettingsSearchEntry[] {
  const entries: SettingsSearchEntry[] = [];
  for (const core of CORE_PAGES) {
    entries.push({ id: `page:${core.page}`, page: core.page, label: core.label, section: "Settings", keywords: core.keywords });
    for (const [label, keywords] of core.rows) {
      entries.push({
        id: `${core.page}:${label}`, page: core.page, label, section: core.label, keywords,
        ...(core.page === "defaults" ? { target: settingAnchor(label) } : {}),
      });
    }
  }
  for (const page of sources.pages) {
    entries.push({
      id: `page:${page.id}`,
      page: page.id,
      label: page.label,
      section: "Settings",
      keywords: [...(page.keywords ?? []), ...(page.extensionName ? [page.extensionName] : [])],
    });
  }
  for (const extension of sources.extensions) {
    if (extension.core) continue;
    entries.push({
      id: `extension:${extension.id}`,
      page: extension.id,
      label: extension.name,
      section: "Extensions",
      keywords: [extension.id, ...(extension.options ?? []).map((option) => option.label)],
    });
  }
  for (const binding of sources.keybindings ?? []) {
    entries.push({
      id: `keybinding:${binding.keys}`,
      page: "keybindings",
      label: binding.commandLabel ?? binding.commandId,
      section: `Keybindings · ${binding.label}`,
      keywords: [binding.commandId, binding.keys],
      filter: binding.commandId,
      secondary: true,
    });
  }
  return entries;
}

export function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\s+/gu, " ").trim();
}

function labelRank(label: string, query: string): number {
  if (label === query) return 3;
  if (label.startsWith(query)) return 2;
  return label.includes(query) ? 1 : 0;
}

/**
 * Entries holding every word of the query in their label, section or keywords;
 * a label that is, starts with or contains the whole query ranks first, and a
 * keybinding row after everything else.
 */
export function searchSettings(entries: readonly SettingsSearchEntry[], query: string, limit = 40): SettingsSearchEntry[] {
  const needle = normalizeSearchText(query);
  if (!needle) return [];
  const tokens = needle.split(" ");
  return entries
    .flatMap((entry, index) => {
      const label = normalizeSearchText(entry.label);
      const haystack = normalizeSearchText([entry.label, entry.section, ...entry.keywords].join(" "));
      if (!tokens.every((token) => haystack.includes(token))) return [];
      return [{ entry, index, rank: labelRank(label, needle) }];
    })
    .sort((left, right) =>
      Number(left.entry.secondary ?? false) - Number(right.entry.secondary ?? false)
      || right.rank - left.rank
      || left.index - right.index)
    .slice(0, limit)
    .map(({ entry }) => entry);
}
