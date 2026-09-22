import type { CommandContribution, ContributionOwner, PaletteItem } from "./extension-system";

export type PaletteCommand = CommandContribution & ContributionOwner;

/** What one source answered for the current query. */
export interface PaletteSourceResult {
  id: string;
  label: string;
  items: readonly PaletteItem[];
}

export type PaletteRow =
  | { kind: "command"; key: string; command: PaletteCommand }
  | { kind: "item"; key: string; item: PaletteItem; source: string };

/** Rows a source may put in one list; the rest is the source's own view's business. */
export const PALETTE_SOURCE_LIMIT = 8;

/** 3: the label starts with the query, 2: contains it, 1: only group or extension does, 0: no match. */
export function scoreCommand(command: PaletteCommand, needle: string): number {
  if (!needle) return 1;
  const index = command.label.toLowerCase().indexOf(needle);
  if (index === 0) return 3;
  if (index > 0) return 2;
  return `${command.group} ${command.extensionName}`.toLowerCase().includes(needle) ? 1 : 0;
}

/** Ranked, then grouped in first-appearance order, so the ranking still drives the layout. */
function commandRows(commands: readonly PaletteCommand[]): PaletteRow[] {
  const byGroup = new Map<string, PaletteCommand[]>();
  for (const command of commands) {
    const existing = byGroup.get(command.group);
    if (existing) existing.push(command);
    else byGroup.set(command.group, [command]);
  }
  return [...byGroup.values()].flat().map((command) => ({ kind: "command", key: `command:${command.id}`, command }));
}

/**
 * One list out of the commands and what the sources answered: commands whose
 * label matches, then each source's rows in source order, then commands that
 * matched only by their group. An empty query lists the commands alone.
 */
export function paletteRows(
  commands: readonly PaletteCommand[],
  needle: string,
  sources: readonly PaletteSourceResult[] = [],
  limit = PALETTE_SOURCE_LIMIT,
): PaletteRow[] {
  const ranked = commands
    .map((command) => ({ command, rank: scoreCommand(command, needle) }))
    .filter((entry) => entry.rank > 0)
    .sort((left, right) => right.rank - left.rank);
  if (!needle) return commandRows(ranked.map((entry) => entry.command));
  const strong = commandRows(ranked.filter((entry) => entry.rank > 1).map((entry) => entry.command));
  const weak = commandRows(ranked.filter((entry) => entry.rank === 1).map((entry) => entry.command));
  const found = sources.flatMap((source) => {
    const seen = new Set<string>();
    return source.items
      .filter((item) => !seen.has(item.id) && Boolean(seen.add(item.id)))
      .slice(0, limit)
      .map((item): PaletteRow => ({ kind: "item", key: `${source.id}:${item.id}`, item, source: source.label }));
  });
  return [...strong, ...found, ...weak];
}
