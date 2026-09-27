import type { ExtensionInspection, ExtensionPackageSummary, HostExtensionSummary } from "../../shared/contracts";
import type { ExtensionSummary } from "../extension-system";

/**
 * Every extension Settings → Extensions lists, from the three places that know
 * one: the window's registry (running desktop halves), the host (its halves,
 * and why one failed to start) and core's scan of the package folders (what a
 * manifest says, and the folders that did not load). Pure, so the states are
 * tested without a host.
 */

/** Where the extension came from. `app` is part of Tau's window itself, with no package. */
export type ExtensionOrigin = "bundled" | "installed" | "app";

/** What the user has to know first. `waiting`, `failed` and `incompatible` need them. */
export type ExtensionState = "on" | "off" | "waiting" | "failed" | "incompatible";

export interface ExtensionEntry {
  id: string;
  name: string;
  description?: string;
  version?: string;
  origin: ExtensionOrigin;
  state: ExtensionState;
  /** Always on: Tau's own, which has no switch. */
  locked: boolean;
  /** What went wrong, for `failed` and `incompatible`. */
  problem?: string;
  /** A theme: only a stylesheet. */
  theme: boolean;
  permissions: readonly string[];
  summary?: ExtensionSummary;
  pkg?: ExtensionPackageSummary;
  host?: HostExtensionSummary;
}

export type ExtensionFilter = "all" | "bundled" | "installed" | "off" | "attention";

export const EXTENSION_FILTERS: ReadonlyArray<{ id: ExtensionFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "bundled", label: "Bundled" },
  { id: "installed", label: "Installed" },
  { id: "off", label: "Turned off" },
  { id: "attention", label: "Needs attention" },
];

export function needsAttention(entry: ExtensionEntry): boolean {
  return entry.state === "waiting" || entry.state === "failed" || entry.state === "incompatible";
}

export function matchesFilter(entry: ExtensionEntry, filter: ExtensionFilter): boolean {
  switch (filter) {
    case "all": return true;
    case "bundled": return entry.origin !== "installed";
    case "installed": return entry.origin === "installed";
    case "off": return entry.state === "off";
    case "attention": return needsAttention(entry);
  }
}

export function matchesQuery(entry: ExtensionEntry, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/u).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = [entry.name, entry.id, entry.description ?? "", entry.summary?.contributes ?? ""].join(" ").toLowerCase();
  return words.every((word) => haystack.includes(word));
}

export function extensionCatalog({ summaries, packages = [], hostHalves = [], errors = [] }: {
  summaries: readonly ExtensionSummary[];
  packages?: readonly ExtensionPackageSummary[];
  hostHalves?: readonly HostExtensionSummary[];
  errors?: ExtensionInspection["errors"];
}): ExtensionEntry[] {
  const entries = new Map<string, ExtensionEntry>();
  const ids = new Set([...summaries.map((entry) => entry.id), ...packages.map((entry) => entry.id), ...hostHalves.map((entry) => entry.id)]);
  for (const id of ids) {
    const summary = summaries.find((entry) => entry.id === id);
    const pkg = packages.find((entry) => entry.id === id);
    const host = hostHalves.find((entry) => entry.id === id);
    const granted = pkg ? pkg.granted !== false : summary?.granted !== false;
    const active = summary ? summary.active : host ? host.active : false;
    const state: ExtensionState = !granted ? "waiting" : host?.error ? "failed" : active ? "on" : "off";
    entries.set(id, {
      id,
      name: summary?.name ?? pkg?.name ?? host?.name ?? id,
      ...(pkg?.description ? { description: pkg.description } : {}),
      ...(pkg?.version ? { version: pkg.version } : {}),
      origin: pkg ? (pkg.scope === "bundled" ? "bundled" : "installed") : "app",
      state,
      locked: summary?.core === true,
      ...(host?.error ? { problem: host.error } : {}),
      theme: pkg?.theme === true,
      permissions: pkg?.permissions ?? summary?.permissions ?? [],
      ...(summary ? { summary } : {}),
      ...(pkg ? { pkg } : {}),
      ...(host ? { host } : {}),
    });
  }
  // A folder that did not load: shown as its package, with the reason.
  for (const error of errors) {
    if (!error.id || entries.has(error.id)) continue;
    entries.set(error.id, {
      id: error.id,
      name: error.name ?? error.id,
      ...(error.version ? { version: error.version } : {}),
      origin: "installed",
      state: error.incompatible ? "incompatible" : "failed",
      locked: false,
      problem: error.message,
      theme: false,
      permissions: [],
    });
  }
  return [...entries.values()].sort((left, right) => left.name.localeCompare(right.name, undefined, { sensitivity: "base" }));
}

/** How many entries each filter keeps, for the counts beside them. */
export function filterCounts(entries: readonly ExtensionEntry[]): Record<ExtensionFilter, number> {
  const counts = { all: 0, bundled: 0, installed: 0, off: 0, attention: 0 } satisfies Record<ExtensionFilter, number>;
  for (const entry of entries) {
    for (const filter of EXTENSION_FILTERS) if (matchesFilter(entry, filter.id)) counts[filter.id] += 1;
  }
  return counts;
}

const STATE_LABELS: Record<ExtensionState, string> = {
  on: "On",
  off: "Off",
  waiting: "Waiting for approval",
  failed: "Failed to start",
  incompatible: "Incompatible",
};

export function stateLabel(state: ExtensionState): string {
  return STATE_LABELS[state];
}

/** The line under a name: the manifest's sentence, or what the extension adds when it has none. */
export function extensionBlurb(entry: ExtensionEntry): string {
  if (entry.description) return entry.description;
  if (entry.theme) return "A theme: colours and type, no code.";
  const contributes = entry.summary?.contributes;
  return contributes ? `Adds ${contributes.split(" · ").slice(0, 4).join(", ")}.` : entry.origin === "app" ? "Part of Tau's window." : "Adds nothing on this device.";
}
