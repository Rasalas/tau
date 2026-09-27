import { useState, useSyncExternalStore, type ComponentType } from "react";
import { ChevronRight, Plus, Search, X } from "lucide-react";
import type { HostExtensionSummary } from "../../shared/contracts";
import type { ExtensionRegistry, SettingsSectionProps } from "../extension-system";
import { Button, SettingsState, Switch } from "./controls";
import {
  EXTENSION_FILTERS,
  extensionBlurb,
  filterCounts,
  matchesFilter,
  matchesQuery,
  needsAttention,
  type ExtensionEntry,
  type ExtensionFilter,
} from "./extension-catalog";
import { ExtensionGlyph, StateBadge, extensionMarks, useExtensionSwitch, type ExtensionMark } from "./ExtensionPage";
import { extensionPage } from "./settings-nav";

function ExtensionRow({ entry, mark, onOpen, onToggle }: {
  entry: ExtensionEntry;
  mark: ExtensionMark | undefined;
  onOpen(): void;
  onToggle(next: boolean): void;
}) {
  const running = entry.state === "on" || entry.state === "failed";
  return (
    <li className="extension-row" data-state={entry.state}>
      <button type="button" className="extension-row-open" onClick={onOpen}>
        <ExtensionGlyph name={entry.name} mark={mark} />
        <span className="extension-row-text">
          <span className="extension-row-name"><strong>{entry.name}</strong><StateBadge entry={entry} /></span>
          <small>{needsAttention(entry) && entry.problem ? entry.problem : extensionBlurb(entry)}</small>
        </span>
      </button>
      <span className="extension-row-control">
        {entry.locked ? <span className="extension-row-note">Always on</span>
          : entry.state === "waiting" ? <Button onClick={onOpen}>Review</Button>
            : entry.state === "incompatible" ? null
              : <Switch label={`${running ? "Turn off" : "Turn on"} ${entry.name}`} checked={running} onChange={onToggle} />}
      </span>
      <ChevronRight className="extension-row-chevron" size={16} aria-hidden />
    </li>
  );
}

/**
 * Settings → Extensions: every extension this window runs or could, as one
 * list to search and filter — kits Tau ships, packages installed for every
 * project or this one, and folders that did not load — with a switch each.
 * A row opens the extension's own page.
 */
export function ExtensionsPage({ entries, registry, loading, error, sections = [], installPage, onOpen, onRetry, onNotify, onHostHalves, onChanged }: {
  entries: readonly ExtensionEntry[];
  registry: ExtensionRegistry;
  loading: boolean;
  error?: string | undefined;
  /** What packages add above the list (`registerSettingsSection({ page: "extensions" })`). */
  sections?: ReadonlyArray<{ id: string; Component: ComponentType<SettingsSectionProps> }>;
  /** The page that installs a package, when an extension offers one. */
  installPage?: string | undefined;
  onOpen(target: string): void;
  onRetry(): void;
  onNotify(message: string): void;
  onHostHalves(halves: HostExtensionSummary[]): void;
  onChanged(): void;
}) {
  useSyncExternalStore(registry.subscribe, registry.getVersion);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ExtensionFilter>("all");
  const toggle = useExtensionSwitch(registry, onNotify, onHostHalves);
  const marks = extensionMarks(registry, entries);
  const counts = filterCounts(entries);
  const shown = entries.filter((entry) => matchesFilter(entry, filter) && matchesQuery(entry, query));
  // Unfiltered, the list reads in three parts: what needs the user, what they installed, what Tau brings.
  const groups = filter === "all" && !query.trim()
    ? [
      { id: "attention", title: "Needs attention", items: shown.filter(needsAttention) },
      { id: "installed", title: "Installed", items: shown.filter((entry) => entry.origin === "installed" && !needsAttention(entry)) },
      { id: "bundled", title: "Bundled with Tau", items: shown.filter((entry) => entry.origin !== "installed" && !needsAttention(entry)) },
    ].filter((group) => group.items.length > 0)
    : [{ id: "results", title: "", items: shown }];
  const row = (entry: ExtensionEntry) => (
    <ExtensionRow key={entry.id} entry={entry} mark={marks.get(entry.id)} onOpen={() => onOpen(extensionPage(entry.id))} onToggle={(next) => { toggle(entry, next); onChanged(); }} />
  );

  return (
    <div className="settings-page extensions-page">
      <div className="extensions-toolbar">
        <label className="settings-filter extensions-search">
          <Search size={14} aria-hidden />
          <input type="search" value={query} placeholder="Filter by name or what it adds" aria-label="Filter extensions" onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
          {query ? <button type="button" className="tau-icon-button" aria-label="Clear the filter" onClick={() => setQuery("")}><X size={13} /></button> : null}
        </label>
        {installPage ? <Button icon={<Plus size={14} />} onClick={() => onOpen(installPage)}>Install…</Button> : null}
      </div>
      <fieldset className="extensions-filters" aria-label="Show">
        {EXTENSION_FILTERS.map((option) => (
          <label key={option.id} data-checked={filter === option.id ? "" : undefined} data-empty={counts[option.id] === 0 && option.id !== "all" ? "" : undefined}>
            <input type="radio" name="extension-filter" value={option.id} checked={filter === option.id} onChange={() => setFilter(option.id)} />
            <span>{option.label}</span>
            <small>{counts[option.id]}</small>
          </label>
        ))}
      </fieldset>

      {sections.map(({ id, Component }) => <Component key={id} onNotify={onNotify} onChanged={onChanged} />)}

      {error ? <SettingsState kind="error" title="The package folders could not be read" description={`${error} The list shows what this window runs.`} onRetry={onRetry} /> : null}
      {entries.length === 0 && loading ? <SettingsState kind="loading" rows={6} title="Loading extensions" /> : null}
      {entries.length === 0 && !loading && !error ? (
        <SettingsState kind="empty" title="No extension runs here" description="Safe mode starts Tau without its kits and packages. Start Tau normally to bring them back." />
      ) : null}
      {entries.length > 0 && shown.length === 0 ? (
        <SettingsState
          kind="empty"
          title={query.trim() ? `No extension matches “${query.trim()}”` : "None in this list"}
          action={<Button onClick={() => { setQuery(""); setFilter("all"); }}>Show all extensions</Button>}
        />
      ) : null}
      {groups.map((group) => group.items.length > 0 ? (
        <section key={group.id} className="extensions-group" aria-label={group.title || "Extensions"}>
          {group.title ? <h2>{group.title}<small>{group.items.length}</small></h2> : null}
          <ul className="extensions-list">{group.items.map(row)}</ul>
        </section>
      ) : null)}
    </div>
  );
}
