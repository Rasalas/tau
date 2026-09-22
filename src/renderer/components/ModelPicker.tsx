import { lazy, Suspense, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Plus, Search, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel, UiRuntimeBackend } from "../../shared/contracts";
import type { ModelBadgeContribution, ModelSelectionContribution } from "../extension-system";
import { modelPresentation, type ModelPresentation } from "../model-manifest";
import { usePreferences } from "../renderer-services-context";
import { DEFAULT_RUNTIME } from "../runtime-marks";
import { modelKey, pickerRail, railKeyForModel, runtimeEntryKey, type RailEntry } from "./model-picker-rail";
import { ProviderIconStack, providerLabel } from "./ProviderIconStack";
import { VirtualList } from "./VirtualList";

const LazyAddModelProviderModal = lazy(() => import("./AddModelProviderModal").then(({ AddModelProviderModal }) => ({ default: AddModelProviderModal })));

const ROW_HEIGHT = 54;
/** ⌘1 to ⌘9 reach the first nine favourites, in the order they were starred. */
const JUMP_KEYS = 9;
const NO_SELECTION: readonly string[] = [];
const noSubscription = () => () => undefined;

export { modelKey };

interface Entry {
  key: string;
  model: UiModel;
  favourite: boolean;
  /** Position among the favourites, when one of the first nine. */
  jump?: number;
  presentation: ModelPresentation;
}

/** One line of the list: a model, or the fold that hides a tab's legacy models. */
type Row =
  | { kind: "model"; key: string; entry: Entry }
  | { kind: "legacy"; key: string; group: string; count: number; expanded: boolean };

/** "added", or "×2" for a model chosen twice. */
function selectedLabel(chosen: readonly string[], key: string): string {
  const count = chosen.filter((entry) => entry === key).length;
  return count > 1 ? `×${count}` : "added";
}

function matches(entry: Entry, needle: string): boolean {
  if (!needle) return true;
  return `${entry.model.name} ${entry.model.provider} ${entry.model.id}`.toLowerCase().includes(needle);
}

const NO_BADGES: readonly ModelBadgeContribution[] = [];

function wears(badge: ModelBadgeContribution, model: UiModel, runtime: ThreadBackendKind | undefined): boolean {
  try { return badge.applies(model, runtime); } catch (error) { console.error(`Model badge ${badge.id} failed`, error); return false; }
}

function runtimeName(kind: string | undefined, backends: readonly UiRuntimeBackend[] | undefined): string {
  const runtime = kind ?? DEFAULT_RUNTIME;
  return backends?.find((backend) => backend.kind === runtime)?.label ?? (runtime === DEFAULT_RUNTIME ? "Pi" : runtime);
}

export function ModelPicker({
  models,
  activeKey,
  onSelect,
  onClose,
  runtime,
  catalogRuntime = runtime,
  runtimeBackends,
  onSelectRuntime,
  onNewThreadOnRuntime,
  badges = NO_BADGES,
  multiSelect,
}: {
  models: readonly UiModel[];
  activeKey?: string;
  onSelect(model: UiModel): void;
  onClose(): void;
  /** The runtime the thread runs on, or the one a thread that does not exist yet will start on. */
  runtime?: ThreadBackendKind;
  /** The runtime `models` belongs to, when a new thread is bound for another one. */
  catalogRuntime?: ThreadBackendKind;
  /** Every runtime the host offers; each one the thread is not on is a tab of its own. */
  runtimeBackends?: readonly UiRuntimeBackend[];
  /** Set while the thread does not exist yet: its runtime can still change. */
  onSelectRuntime?(kind: ThreadBackendKind): void;
  /** For a thread that exists: another runtime means another thread. */
  onNewThreadOnRuntime?(kind: ThreadBackendKind): void;
  /** Marks extensions put on model rows (`registerModelBadge`). */
  badges?: readonly ModelBadgeContribution[];
  /** Shift-click builds a set of models here instead of picking one; a new thread's picker only. */
  multiSelect?: ModelSelectionContribution;
}) {
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [expandedLegacy, setExpandedLegacy] = useState<ReadonlySet<string>>(() => new Set());
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const draft = onSelectRuntime !== undefined;
  const threadRuntime = runtime ?? catalogRuntime ?? DEFAULT_RUNTIME;
  const chosen = useSyncExternalStore(
    multiSelect?.subscribe ?? noSubscription,
    () => multiSelect?.selected() ?? NO_SELECTION,
    () => NO_SELECTION,
  );

  const entries = useMemo<Entry[]>(
    () => models.map((model) => {
      const key = modelKey(model);
      const position = settings.favouriteModels.indexOf(key);
      return {
        key,
        model,
        favourite: position >= 0,
        ...(position >= 0 && position < JUMP_KEYS ? { jump: position + 1 } : {}),
        presentation: modelPresentation(model),
      };
    }),
    [models, settings.favouriteModels],
  );

  const rail = useMemo<RailEntry[]>(() => pickerRail({
    providers: [...new Set(entries.map((entry) => entry.model.provider))].sort(),
    catalogRuntime,
    backends: runtimeBackends,
    favourites: entries.some((entry) => entry.favourite),
  }), [catalogRuntime, entries, runtimeBackends]);
  const railKeys = useMemo(() => rail.map((item) => item.key), [rail]);
  const current = rail.find((item) => item.key === tab);

  // Open where the thread already is: its runtime's tab, or its model's.
  useEffect(() => {
    setTab((held) => {
      if (held && railKeys.includes(held)) return held;
      if (threadRuntime !== (catalogRuntime ?? DEFAULT_RUNTIME)) return runtimeEntryKey(threadRuntime);
      const active = entries.find((entry) => entry.key === activeKey);
      if (active) return railKeyForModel(active.model.provider, catalogRuntime);
      return (catalogRuntime ?? DEFAULT_RUNTIME) === DEFAULT_RUNTIME ? railKeys[0] : runtimeEntryKey(catalogRuntime as string);
    });
  }, [activeKey, catalogRuntime, entries, railKeys, threadRuntime]);

  // A legacy model in use is not hidden from the person using it.
  useEffect(() => {
    const active = entries.find((entry) => entry.key === activeKey);
    if (!active?.presentation.legacy) return;
    const group = railKeyForModel(active.model.provider, catalogRuntime);
    setExpandedLegacy((held) => held.has(group) ? held : new Set([...held, group]));
  }, [activeKey, catalogRuntime, entries]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const needle = query.trim().toLowerCase();

  // A query searches the whole catalog; without one, the rail tab scopes the list.
  const rows = useMemo<Row[]>(() => {
    const filtered = entries.filter((entry) => matches(entry, needle));
    const asRows = (list: Entry[]): Row[] => list.map((entry) => ({ kind: "model", key: entry.key, entry }));
    if (needle) return asRows(filtered);
    if (!current) return [];
    if (current.kind === "favourites") return asRows(filtered.filter((entry) => entry.favourite));
    if (current.kind === "runtime" && !current.listed) return [];
    const scoped = current.kind === "provider" ? filtered.filter((entry) => entry.model.provider === current.provider) : filtered;
    const latest = scoped.filter((entry) => !entry.presentation.legacy);
    const legacy = scoped.filter((entry) => entry.presentation.legacy);
    if (legacy.length === 0) return asRows(scoped);
    const expanded = expandedLegacy.has(current.key);
    return [
      ...asRows(latest),
      { kind: "legacy", key: `legacy:${current.key}`, group: current.key, count: legacy.length, expanded },
      ...(expanded ? asRows(legacy) : []),
    ];
  }, [current, entries, expandedLegacy, needle]);

  useEffect(() => setCursor(0), [needle, tab]);

  const notes = useMemo(() => {
    const listed = rows.flatMap((row) => row.kind === "model" ? [row.entry.model] : []);
    return [...new Set(badges.filter((badge) => badge.note && listed.some((model) => wears(badge, model, catalogRuntime))).map((badge) => badge.note as string))];
  }, [badges, catalogRuntime, rows]);

  const toggleLegacy = (group: string) => {
    setExpandedLegacy((held) => {
      const next = new Set(held);
      if (next.has(group)) next.delete(group);
      else next.add(group);
      return next;
    });
  };

  // A runtime whose models are not on hand: say what choosing it means.
  const elsewhere = !needle && current?.kind === "runtime" && !current.listed ? current.backend : undefined;
  const threadRuntimeName = runtimeName(threadRuntime, runtimeBackends);
  const paneAction = elsewhere && elsewhere.kind !== threadRuntime
    ? draft
      ? { label: `Start this thread on ${elsewhere.label}`, run: () => onSelectRuntime?.(elsewhere.kind) }
      : onNewThreadOnRuntime ? { label: `New thread on ${elsewhere.label}`, run: () => { onNewThreadOnRuntime(elsewhere.kind); onClose(); } } : undefined
    : undefined;

  const choose = (entry: Entry, add = false) => {
    if (multiSelect && add) {
      multiSelect.toggle(entry.model, entries.find((candidate) => candidate.key === activeKey)?.model);
      return;
    }
    multiSelect?.reset();
    onSelect(entry.model);
    onClose();
  };
  const activate = (row: Row | undefined, alt: boolean, add = false) => {
    if (!row) return;
    if (row.kind === "legacy") { toggleLegacy(row.group); return; }
    if (alt) preferences.toggleFavouriteModel(row.key);
    else choose(row.entry, add);
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { onClose(); return; }
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/u.test(event.key)) {
      const target = entries.find((entry) => entry.jump === Number(event.key));
      if (target) { event.preventDefault(); choose(target); }
      return;
    }
    if ((event.key === "ArrowLeft" || event.key === "ArrowRight") && (!needle || event.altKey)) {
      if (railKeys.length > 1) {
        event.preventDefault();
        if (needle) setQuery("");
        setTab((held) => {
          const index = held ? railKeys.indexOf(held) : 0;
          const delta = event.key === "ArrowRight" ? 1 : -1;
          return railKeys[(index + delta + railKeys.length) % railKeys.length];
        });
      }
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (rows.length ? (value + 1) % rows.length : 0));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (rows.length ? (value - 1 + rows.length) % rows.length : 0));
    }
    // Enter on a focused button is that button's own click; only the field selects the cursor row.
    if (event.key === "Enter" && event.target === inputRef.current) {
      event.preventDefault();
      if (paneAction) paneAction.run();
      else activate(rows[cursor], event.altKey, event.shiftKey);
    }
  };

  const tabLabel = (item: RailEntry): string => {
    if (item.kind === "favourites") return `Favourites (${entries.filter((entry) => entry.favourite).length})`;
    if (item.kind === "provider") return `${providerLabel(item.provider)} (${entries.filter((entry) => entry.model.provider === item.provider).length})`;
    return item.listed ? `${item.backend.label} (${entries.length})` : item.backend.label;
  };
  const tabTitle = (item: RailEntry): string => {
    if (item.kind !== "runtime" || item.listed) return tabLabel(item).replace(/ \((\d+)\)$/u, " · $1");
    if (item.backend.kind === threadRuntime) return `${item.backend.label} · this thread's runtime`;
    return draft ? `${item.backend.label} · run this thread on it` : `${item.backend.label} · starts a new thread`;
  };
  const inUse = (key: string) => key === activeKey && threadRuntime === (catalogRuntime ?? DEFAULT_RUNTIME);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Select model"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="model-picker-body">
          <nav className="model-rail" aria-label="Providers">
            {rail.map((item) => (
              <button
                key={item.key}
                className={[
                  !needle && item.key === tab ? "active" : "",
                  item.kind === "runtime" && !item.listed && !draft && item.backend.kind !== threadRuntime ? "elsewhere" : "",
                ].filter(Boolean).join(" ")}
                aria-label={tabLabel(item)}
                aria-pressed={!needle && item.key === tab}
                title={tabTitle(item)}
                onClick={() => { setQuery(""); setTab(item.key); }}
              >
                {item.kind === "favourites"
                  ? <Star size={16} fill="currentColor" />
                  : item.kind === "provider"
                    ? <ProviderIconStack modelProvider={item.provider} className="rail-icon" />
                    : <ProviderIconStack runtimeProvider={item.backend.kind} className="rail-icon" />}
              </button>
            ))}
          </nav>

          <div className="model-main">
            <div className="palette-input-wrap model-search">
              <Search size={15} />
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search models…"
                aria-label="Search models"
              />
              <kbd>esc</kbd>
              <button
                className="model-provider-add"
                aria-label="Add custom model provider"
                title="Add custom model provider"
                onClick={() => setAddProviderOpen(true)}
              >
                <Plus size={14} />
              </button>
            </div>

            {elsewhere ? (
              <div className="model-runtime-pane" role="region" aria-label={elsewhere.label}>
                <ProviderIconStack runtimeProvider={elsewhere.kind} className="runtime-pane-icon" />
                <strong>{elsewhere.label}</strong>
                <p>{elsewhere.kind === threadRuntime
                  ? `This thread starts on ${elsewhere.label} with its default model. Its models are listed once the thread exists.`
                  : draft
                    ? `${elsewhere.label} runs the thread instead of ${threadRuntimeName}. Its models are listed once the thread exists.`
                    : `This thread runs on ${threadRuntimeName}, and a thread keeps the runtime it started on. ${elsewhere.label} runs a thread of its own.`}</p>
                {paneAction ? <button className="primary" onClick={paneAction.run}>{paneAction.label}</button> : null}
              </div>
            ) : <VirtualList
              items={rows}
              itemHeight={ROW_HEIGHT}
              className="model-list"
              scrollToIndex={cursor}
              empty={<p className="palette-empty">{needle ? `No model matches “${query}”.` : "No models from this provider."}</p>}
              renderItem={(row, index) => row.kind === "legacy"
                ? <div key={row.key} className={`model-row model-legacy ${index === cursor ? "selected" : ""}`} onMouseMove={() => setCursor(index)}>
                  <button className="model-choose" aria-expanded={row.expanded} onClick={() => toggleLegacy(row.group)}>
                    <span className="model-line"><strong>Legacy models</strong></span>
                    <small className="model-sub">{row.count} {row.count === 1 ? "model" : "models"}</small>
                  </button>
                  <span className="model-chevron">{row.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                </div>
                : <div
                  key={row.key}
                  data-provider={row.entry.model.provider}
                  className={`model-row ${index === cursor ? "selected" : ""} ${inUse(row.key) ? "current" : ""}`}
                  onMouseMove={() => setCursor(index)}
                >
                  <button className="model-choose" onClick={(event) => choose(row.entry, event.shiftKey)}>
                    <span className="model-line">
                      <strong>{row.entry.model.name}</strong>
                      {row.entry.presentation.badge === "new" ? <span className="model-badge model-badge-new">NEW</span> : null}
                      {needle && row.entry.presentation.legacy ? <span className="model-badge">legacy</span> : null}
                      {row.entry.model.login === "subscription" ? <span className="model-badge">subscription login</span> : null}
                      {badges.filter((badge) => wears(badge, row.entry.model, catalogRuntime)).map((badge) => (
                        <span key={badge.id} className={`model-badge${badge.tone === "warning" ? " model-badge-warning" : ""}`} title={badge.title}>{badge.label}</span>
                      ))}
                    </span>
                    <small className="model-sub">
                      <ProviderIconStack modelProvider={row.entry.model.provider} runtimeProvider={catalogRuntime} className="sub-icon" />
                      {providerLabel(row.entry.model.provider)}
                      <span className="model-id">{row.entry.model.id}</span>
                    </small>
                  </button>
                  {inUse(row.key) && chosen.length === 0 ? <em>in use</em> : null}
                  {chosen.includes(row.key) ? <em className="model-chosen">{selectedLabel(chosen, row.key)}</em> : null}
                  {row.entry.jump ? <kbd className="model-kbd">⌘{row.entry.jump}</kbd> : null}
                  <button className={`model-star ${row.entry.favourite ? "on" : ""}`} aria-label={row.entry.favourite ? `Unfavourite ${row.entry.model.name}` : `Favourite ${row.entry.model.name}`} aria-pressed={row.entry.favourite} onClick={() => preferences.toggleFavouriteModel(row.key)}><Star size={14} fill={row.entry.favourite ? "currentColor" : "none"} /></button>
                </div>}
            />}
          </div>
        </div>

        {notes.map((note) => <p key={note} className="model-picker-note">{note}</p>)}

        <footer>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>⌥↵ favourite</span>
          <span>⌘1–9 favourite n</span>
          {multiSelect ? <span>{chosen.length > 1 ? `${chosen.length} models chosen` : "⇧click add a model"}</span> : null}
          <span className="spacer" />
          <span>{entries.length} models · {new Set(entries.map((entry) => entry.model.provider)).size} providers</span>
        </footer>
      </section>
      {addProviderOpen ? (
        <Suspense fallback={null}>
          <LazyAddModelProviderModal
            onClose={() => setAddProviderOpen(false)}
            onProviderAdded={(newModels) => {
              setAddProviderOpen(false);
              const latest = newModels[newModels.length - 1];
              if (latest) setTab(railKeyForModel(latest.provider, catalogRuntime));
            }}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
