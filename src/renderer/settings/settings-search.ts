import { extensionPage } from "./settings-nav";

/**
 * What the Settings search finds: core's own rows with the words people use
 * for them, the pages extensions contributed with their keywords and the rows
 * they named, each extension's own page and every keybinding. Pure, so the
 * ranking is tested without the modal; the palette reads the same entries.
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
    page: "general",
    label: "General",
    keywords: ["defaults", "preferences", "behaviour", "behavior"],
    rows: [
      ["Transcript detail", ["focused", "detailed", "everything", "tool output", "show thinking"]],
      ["Show costs", ["cost", "money", "spend", "price"]],
      ["Composer editing mode", ["vim", "readline", "emacs", "modal"]],
      ["Fold the composer while scrolling", ["fold", "composer", "scroll"]],
      ["Send with", ["send", "enter", "submit", "shortcut"]],
      ["Theme", ["appearance", "dark", "light", "system", "color", "colour"]],
      ["Keep the host running in the background", ["host", "background", "quit"]],
      ["Continue threads after restarts", ["restart", "resume", "interrupted"]],
      ["Reload files when they change", ["watch", "hot reload", "extensions", "packages", "themes", "config"]],
      ["Quit shortcut", ["quit", "cmd q", "hold", "press twice", "confirm", "confirmation"]],
      ["Ask before quitting while threads work", ["quit", "confirm", "confirmation", "running", "ask"]],
      ["Update track", ["update", "updates", "nightly", "stable", "channel", "prerelease", "beta"]],
    ],
  },
  {
    page: "models",
    label: "Models",
    keywords: ["defaults", "new threads", "model", "runtime"],
    rows: [
      ["Default model", ["model", "provider", "add provider", "custom model"]],
      ["Thinking level", ["thinking", "reasoning", "effort"]],
      ["Runtime for new threads", ["runtime", "backend", "program"]],
      ["Temperature", ["temperature", "sampling", "model parameters"]],
      ["Max tokens", ["max tokens", "answer length", "model parameters"]],
    ],
  },
  {
    page: "pi",
    label: "Pi",
    keywords: ["agent", "settings.json"],
    rows: [
      ["Write Pi settings to", ["global", "project", "scope", "settings.json", "all projects"]],
      ["Project trust", ["trust", "ask", "always", "never", "project settings"]],
      ["Startup model", ["default model", "pi model"]],
      ["Startup thinking level", ["thinking", "reasoning", "effort", "default thinking"]],
      ["Quiet startup", ["startup", "header", "banner"]],
      ["Automatic compaction", ["compaction", "compact", "summarize", "context window"]],
      ["Reserve tokens", ["compaction", "reply", "context"]],
      ["Keep recent tokens", ["compaction", "unsummarized", "context"]],
      ["Retry on transient errors", ["retry", "retries", "errors", "backoff"]],
      ["Max retries", ["retry", "retries", "attempts"]],
      ["Base delay", ["retry", "delay", "backoff", "ms"]],
      ["Steering messages", ["message delivery", "steering", "steer", "queue"]],
      ["Follow-up messages", ["message delivery", "follow-up", "follow up", "queue"]],
      ["Built-in tools", ["tools", "read", "bash", "powershell", "edit", "write", "grep", "find", "ls"]],
      ["Shell path", ["shell", "bash", "cygwin"]],
      ["Command prefix", ["shell", "bash", "prefix"]],
      ["npm command", ["npm", "packages", "mise"]],
    ],
  },
  {
    page: "keybindings",
    label: "Keybindings",
    keywords: ["shortcuts", "chords", "keys", "keymap", "keybindings.json"],
    rows: [],
  },
  {
    page: "connections",
    label: "Connections",
    keywords: ["pairing", "pair", "devices", "clients", "web client", "browser", "phone", "qr", "revoke", "sessions", "host token", "rotate", "remote"],
    rows: [
      ["Host token", ["rotate", "token", "secret"]],
      ["Authorized clients", ["pairing link", "revoke", "sessions", "devices"]],
      ["Run as a system service", ["service", "background", "launchd", "launchagent", "systemd", "task scheduler", "login", "boot", "daemon"]],
      ["Invisible display", ["xvfb", "display", "headless", "linux", "preview", "screen", "x11"]],
      ["Keep this machine awake while turns run", ["awake", "sleep", "caffeinate", "power"]],
    ],
  },
  {
    page: "extensions",
    label: "Extensions",
    keywords: ["kits", "packages", "plugins", "add-ons", "installed", "bundled", "disable", "enable", "permissions", "approve"],
    rows: [],
  },
  {
    page: "about",
    label: "About",
    keywords: ["version", "licenses", "licences", "open source", "third party", "notices", "release notes", "updates"],
    rows: [
      ["Open-source licenses", ["licenses", "licences", "third party", "notices", "credits"]],
    ],
  },
  {
    page: "inspector",
    label: "Inspector",
    keywords: ["extensions", "packages", "versions", "system prompt", "problems", "debug"],
    rows: [
      ["Versions", ["tau version", "pi version", "extension api", "engines"]],
      ["System prompt and persona", ["system prompt", "instructions", "agents.md", "persona"]],
      ["Packages on disk", ["package folders", "tau-extension.json", "load errors", "incompatible"]],
    ],
  },
];

export interface SettingsSearchSources {
  /** Pages extensions contributed, with the rows they named for the search. */
  pages: ReadonlyArray<{ id: string; label: string; keywords?: readonly string[] | undefined; extensionName?: string; rows?: ReadonlyArray<{ id: string; label: string; keywords?: readonly string[] | undefined }> | undefined }>;
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
        // Each core row carries `settingAnchor(label)` as its element id.
        target: settingAnchor(label),
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
    for (const row of page.rows ?? []) {
      entries.push({ id: `${page.id}:${row.id}`, page: page.id, label: row.label, section: page.label, keywords: row.keywords ?? [], target: row.id });
    }
  }
  for (const extension of sources.extensions) {
    if (extension.core) continue;
    entries.push({
      id: `extension:${extension.id}`,
      page: extensionPage(extension.id),
      label: extension.name,
      section: "Extensions",
      keywords: [extension.id, ...(extension.options ?? []).map((option) => option.label)],
    });
  }
  const seen = new Set<string>();
  const pairs = new Set<string>();
  for (const binding of sources.keybindings ?? []) {
    // One chord may run different commands in different contexts, and one command may hold a chord twice.
    if (pairs.has(`${binding.keys} ${binding.commandId}`)) continue;
    pairs.add(`${binding.keys} ${binding.commandId}`);
    const id = seen.has(`keybinding:${binding.keys}`) ? `keybinding:${binding.keys}:${binding.commandId}` : `keybinding:${binding.keys}`;
    seen.add(id);
    entries.push({
      id,
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
