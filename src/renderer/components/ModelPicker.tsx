import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowDownUp, ChevronDown, ChevronRight, Clock, Eye, Layers, ListFilter, Plus, Search, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel, UiRuntimeBackend } from "../../shared/contracts";
import type { ModelBadgeContribution, ModelSelectionContribution } from "../extension-system";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { withPriceOverride } from "../../shared/model-prices";
import { modelPresentation } from "../model-manifest";
import { usePreferences } from "../renderer-services-context";
import { DEFAULT_RUNTIME } from "../runtime-marks";
import { runtimeInstanceId } from "../../shared/runtime-instances";
import { runtimeUpdate } from "../runtime-update";
import {
  RUNTIME_STATUS_LABELS, pickerViews, runtimeView, type ViewEntry,
} from "./model-picker-rail";
import {
  NO_FILTERS, filterCount, modelKey, offeringKey, orderedPositions, passesFilters, searchOfferings, sortOfferings,
  type BillingFilter, type CapabilityFilter, type Offering, type OfferingFilters, type OfferingSort,
} from "./model-offerings";
import { OfferingRow, wears, type RowCell } from "./ModelPickerRow";
import { ProviderIconStack, monogram, providerLabel } from "./ProviderIconStack";
import { Popover } from "./ui/Dialog";
import { useFocusTrap } from "./ui/focus";
import { tooltipProps } from "./ui/Tooltip";
import { VirtualList } from "./VirtualList";
import "./model-picker.css";

const LazyAddModelProviderModal = lazy(() => import("./AddModelProviderModal").then(({ AddModelProviderModal }) => ({ default: AddModelProviderModal })));

/** ⌘1 to ⌘9 reach the first nine favourites, in the order they were starred. */
const JUMP_KEYS = 9;
/** Below this window width the provider column becomes a filter above the list. */
const NARROW_WIDTH = 760;
const NO_SELECTION: readonly string[] = [];
const NO_CATALOGS: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry> = new Map();
const NO_BADGES: readonly ModelBadgeContribution[] = [];
const NO_ACTIONS: readonly RuntimeAction[] = [];
const noSubscription = () => () => undefined;

export { modelKey };

/** Something to do with another runtime than the thread's, besides a new thread on it ("Continue in…"). */
export interface RuntimeAction {
  id: string;
  /** Drawn with the runtime's name: "Continue in" → "Continue in Codex". */
  label: string;
  run(runtime: ThreadBackendKind): void;
}

/** One line of the list. */
type Row =
  | { kind: "offering"; key: string; offering: Offering; grouped: boolean; cross: boolean }
  | { kind: "group"; key: string; name: string; count: number }
  | { kind: "legacy"; key: string; count: number; expanded: boolean };

const rowHeight = (row: Row): number => row.kind === "group" ? 26 : row.kind === "legacy" ? 44 : row.grouped ? 42 : 52;
const selectable = (row: Row | undefined): boolean => row !== undefined && row.kind !== "group";

const SORT_LABELS: Record<OfferingSort, string> = { relevance: "Relevance", price: "Price", context: "Context", newest: "Newest" };
const BILLING_FILTERS: ReadonlyArray<[BillingFilter, string]> = [["subscription", "Plan"], ["api", "API key"], ["free", "Free or local"]];
const CAPABILITY_FILTERS: ReadonlyArray<[CapabilityFilter, string]> = [["images", "Reads images"], ["reasoning", "Reasoning"]];

/** "added", or "×2" for a model chosen twice. */
function selectedLabel(chosen: readonly string[], key: string): string {
  const count = chosen.filter((entry) => entry === key).length;
  return count > 1 ? `×${count}` : "added";
}

/** Why a runtime lists no models, in the words its catalog gives. */
function unlistedReason(label: string, entry: RuntimeCatalogEntry | undefined): string | undefined {
  if (entry?.status === "loading") return `Asking ${label} for its models…`;
  if (entry?.status !== "unavailable") return undefined;
  if (entry.message) return entry.message;
  if (entry.reason === "not-installed") return `${label} is not installed.`;
  if (entry.reason === "sign-in-required") return `${label} needs you to sign in.`;
  return undefined;
}

function runtimeName(kind: string | undefined, backends: readonly UiRuntimeBackend[] | undefined): string {
  const runtime = kind ?? DEFAULT_RUNTIME;
  return backends?.find((backend) => backend.kind === runtime)?.label ?? (runtime === DEFAULT_RUNTIME ? "Pi" : runtime);
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`;
}

/** A provider's mark in the provider column, or one for all of them. */
function ProviderChoiceMark({ provider }: { provider: string | undefined }) {
  return provider
    ? <ProviderIconStack modelProvider={provider} className="provider-column-icon" hint={false} />
    : <Layers size={16} className="provider-all-glyph" aria-hidden />;
}

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof window !== "undefined" && window.innerWidth > 0 && window.innerWidth < NARROW_WIDTH);
  useEffect(() => {
    const update = () => setNarrow(window.innerWidth > 0 && window.innerWidth < NARROW_WIDTH);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return narrow;
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** A printable key typed while a column has focus belongs in the search field. */
function typedCharacter(event: KeyboardEvent): string | undefined {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " " ? event.key : undefined;
}

/** Moves focus to the previous or next button of a column and returns it. */
function stepColumn(column: HTMLElement | null, delta: 1 | -1): HTMLButtonElement | undefined {
  const buttons = [...column?.querySelectorAll<HTMLButtonElement>("button[data-column-item]") ?? []];
  if (buttons.length === 0) return undefined;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[(index + delta + buttons.length) % buttons.length];
  next?.focus();
  return next;
}

function focusColumn(column: HTMLElement | null): boolean {
  const button = column?.querySelector<HTMLButtonElement>("button[data-column-item][aria-pressed=true]") ?? column?.querySelector<HTMLButtonElement>("button[data-column-item]");
  button?.focus();
  return Boolean(button);
}

export function ModelPicker({
  models,
  activeKey,
  onSelect,
  onClose,
  runtime,
  catalogRuntime = runtime,
  runtimeBackends,
  catalogs = NO_CATALOGS,
  onSelectRuntime,
  onNewThreadOnRuntime,
  runtimeActions = NO_ACTIONS,
  badges = NO_BADGES,
  multiSelect,
  anchor,
  side = "top",
}: {
  models: readonly UiModel[];
  /** `provider/id` of the model in use, from the catalog on hand. */
  activeKey?: string;
  /** `runtime` is set for a model of another runtime's catalog than the one on hand. */
  onSelect(model: UiModel, runtime?: ThreadBackendKind): void;
  onClose(): void;
  /** The runtime the thread runs on, or the one a thread that does not exist yet will start on. */
  runtime?: ThreadBackendKind;
  /** The runtime `models` belongs to, when a new thread is bound for another one. */
  catalogRuntime?: ThreadBackendKind;
  /** Every runtime the host offers; each is an entry of the left column. */
  runtimeBackends?: readonly UiRuntimeBackend[];
  /** The host's catalogs of every runtime, so another runtime lists its models too. */
  catalogs?: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry>;
  /** Set while the thread does not exist yet: its runtime can still change. */
  onSelectRuntime?(kind: ThreadBackendKind): void;
  /** For a thread that exists: another runtime means another thread, which starts on `model` when one was chosen. */
  onNewThreadOnRuntime?(kind: ThreadBackendKind, model?: UiModel): void;
  /** For a thread that exists: what else can be done with another runtime (`runtime-switch` commands). */
  runtimeActions?: readonly RuntimeAction[];
  /** Marks extensions put on model rows (`registerModelBadge`). */
  badges?: readonly ModelBadgeContribution[];
  /** Shift-click builds a set of models here instead of picking one; a new thread's picker only. */
  multiSelect?: ModelSelectionContribution;
  /** The control the picker opens beside, as T3 Code's picker at its chip. */
  anchor: RefObject<HTMLElement | null>;
  /** Where it prefers to open; it flips when that side has no room. */
  side?: "top" | "bottom";
}) {
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const narrow = useNarrow();
  const onHand = catalogRuntime ?? DEFAULT_RUNTIME;
  const threadRuntime = runtime ?? onHand;
  const draft = onSelectRuntime !== undefined;
  const [query, setQuery] = useState("");
  const [view, setView] = useState(() => runtimeView(threadRuntime));
  const [providers, setProviders] = useState<Record<string, string | undefined>>(() => {
    const active = activeKey && threadRuntime === onHand ? models.find((model) => modelKey(model) === activeKey) : undefined;
    return active ? { [onHand]: active.provider } : {};
  });
  const [sort, setSort] = useState<OfferingSort>("relevance");
  const [filters, setFilters] = useState<OfferingFilters>(NO_FILTERS);
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<"sort" | "filter">();
  const [cursor, setCursor] = useState<number>();
  const [expandedLegacy, setExpandedLegacy] = useState<ReadonlySet<string>>(() => new Set());
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const runtimeColumnRef = useRef<HTMLElement>(null);
  const providerColumnRef = useRef<HTMLElement>(null);
  const chosen = useSyncExternalStore(
    multiSelect?.subscribe ?? noSubscription,
    () => multiSelect?.selected() ?? NO_SELECTION,
    () => NO_SELECTION,
  );

  const views = useMemo(() => pickerViews({ catalogRuntime: onHand, backends: runtimeBackends, catalogs, recent: settings.recentModels.length > 0 }), [catalogs, onHand, runtimeBackends, settings.recentModels.length]);
  const labels = useMemo(() => new Map(views.flatMap((entry) => entry.kind === "runtime" ? [[entry.backend.kind, entry.backend.label] as const] : [])), [views]);
  const activeOffering = activeKey && threadRuntime === onHand ? (onHand === DEFAULT_RUNTIME ? activeKey : `${onHand}:${activeKey}`) : undefined;

  // Every offering of every runtime whose models are on hand: the thread's own catalog, the host's for the rest.
  const offerings = useMemo<Offering[]>(() => {
    const favourites = new Set(settings.favouriteModels);
    const result: Offering[] = [];
    for (const entry of views) {
      if (entry.kind !== "runtime" || !entry.listed) continue;
      const kind = entry.backend.kind;
      const cached = catalogs.get(kind);
      const catalog = cached?.status === "ready" ? cached.catalog : undefined;
      let list: readonly UiModel[];
      if (kind === onHand) {
        // A thread's own list is lean; the host's catalog knows price, context and billing.
        const facts = new Map(catalog?.models.map((model) => [modelKey(model), model] as const));
        list = models.map((model) => ({ ...facts.get(modelKey(model)), ...model }));
      } else {
        list = catalog?.models ?? [];
      }
      const arranged = settings.modelPreferences[kind];
      const hidden = new Set(arranged?.hidden);
      const positions = orderedPositions(list, arranged?.order);
      for (const listed of list) {
        const { model, custom } = withPriceOverride(listed, settings.modelPrices);
        const key = offeringKey(kind, model);
        const presentation = modelPresentation(model);
        result.push({
          key,
          runtime: kind,
          runtimeLabel: entry.backend.label,
          model,
          levels: catalog?.thinkingLevels[model.id] ?? [],
          favourite: favourites.has(key),
          hidden: hidden.has(modelKey(model)),
          legacy: presentation.legacy,
          isNew: presentation.badge === "new",
          position: positions.get(modelKey(model)) ?? 0,
          ...(custom ? { customPrice: true } : {}),
        });
      }
    }
    return result;
  }, [catalogs, models, onHand, settings.favouriteModels, settings.modelPreferences, settings.modelPrices, views]);
  const byKey = useMemo(() => new Map(offerings.map((offering) => [offering.key, offering] as const)), [offerings]);
  const jumps = useMemo(() => {
    const map = new Map<string, number>();
    for (const key of settings.favouriteModels) {
      if (map.size >= JUMP_KEYS) break;
      if (byKey.has(key)) map.set(key, map.size + 1);
    }
    return map;
  }, [byKey, settings.favouriteModels]);

  const current = views.find((entry) => entry.key === view) ?? views.find((entry) => entry.kind === "runtime");
  const currentRuntime = current?.kind === "runtime" ? current : undefined;
  const runtimeOfferings = useMemo(() => currentRuntime ? offerings.filter((offering) => offering.runtime === currentRuntime.backend.kind) : [], [currentRuntime, offerings]);
  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const offering of runtimeOfferings) if (!offering.hidden || showHidden) counts.set(offering.model.provider, (counts.get(offering.model.provider) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => providerLabel(a).localeCompare(providerLabel(b)));
  }, [runtimeOfferings, showHidden]);
  const providerColumn = currentRuntime !== undefined && providerCounts.length > 1;
  const chosenProvider = currentRuntime ? providers[currentRuntime.backend.kind] : undefined;
  const provider = chosenProvider && providerCounts.some(([name]) => name === chosenProvider) ? chosenProvider : undefined;

  const needle = query.trim();
  const shown = useCallback(
    (offering: Offering) => (showHidden || !offering.hidden || offering.key === activeOffering) && passesFilters(offering, filters),
    [activeOffering, filters, showHidden],
  );
  const hiddenCount = (needle ? offerings : runtimeOfferings).filter((offering) => offering.hidden).length;

  const rows = useMemo<Row[]>(() => {
    const offeringRow = (offering: Offering, grouped = false, cross = false): Row => ({ kind: "offering", key: offering.key, offering, grouped, cross });
    if (needle) {
      const found: Row[] = [];
      for (const group of searchOfferings(offerings.filter(shown), needle, sort, providerLabel, threadRuntime)) {
        if (group.length > 1) found.push({ kind: "group", key: `group:${group[0]!.key}`, name: group[0]!.model.name, count: group.length });
        for (const offering of group) found.push(offeringRow(offering, group.length > 1, true));
      }
      return found;
    }
    if (!current) return [];
    if (current.kind === "favourites" || current.kind === "recent") {
      const keys = current.kind === "favourites" ? settings.favouriteModels : settings.recentModels;
      const listed = keys.flatMap((key) => { const offering = byKey.get(key); return offering && passesFilters(offering, filters) ? [offering] : []; });
      return (sort === "relevance" ? listed : sortOfferings(listed, sort)).map((offering) => offeringRow(offering, false, true));
    }
    if (!current.listed) return [];
    const scoped = sortOfferings(runtimeOfferings.filter((offering) => shown(offering) && (!provider || offering.model.provider === provider)), sort);
    const latest = scoped.filter((offering) => !offering.legacy);
    const legacy = scoped.filter((offering) => offering.legacy);
    // The fold is the runtime's own order's; a sort or filter lists everything.
    if (legacy.length === 0 || sort !== "relevance" || filterCount(filters) > 0) return scoped.map((offering) => offeringRow(offering));
    const group = `${current.key}/${provider ?? ""}`;
    const expanded = expandedLegacy.has(group) || legacy.some((offering) => offering.key === activeOffering);
    return [
      ...latest.map((offering) => offeringRow(offering)),
      { kind: "legacy", key: `legacy:${group}`, count: legacy.length, expanded },
      ...(expanded ? legacy.map((offering) => offeringRow(offering)) : []),
    ];
  }, [activeOffering, byKey, current, expandedLegacy, filters, needle, offerings, provider, runtimeOfferings, settings.favouriteModels, settings.recentModels, shown, sort, threadRuntime]);

  // The cursor starts on the model in use, else on the first row; it follows every new list.
  const initialCursor = useMemo(() => {
    const active = rows.findIndex((row) => row.kind === "offering" && row.key === activeOffering);
    // A search, sort or filter starts at the top of what it produced.
    return active >= 0 && !needle && sort === "relevance" && filterCount(filters) === 0 ? active : rows.findIndex(selectable);
  }, [activeOffering, filters, needle, rows, sort]);
  useEffect(() => setCursor(undefined), [needle, view, provider, sort, filters]);
  const at = cursor !== undefined && selectable(rows[cursor]) ? cursor : initialCursor;

  // Again after the add-provider form, which a popover picker gives its place to.
  useEffect(() => {
    if (!addProviderOpen) requestAnimationFrame(() => inputRef.current?.focus());
  }, [addProviderOpen]);
  useFocusTrap(surfaceRef, !addProviderOpen);

  const notes = useMemo(() => {
    const listed = rows.flatMap((row) => row.kind === "offering" ? [row.offering] : []);
    return [...new Set(badges.filter((badge) => badge.note && listed.some((offering) => wears(badge, offering.model, offering.runtime))).map((badge) => badge.note as string))];
  }, [badges, rows]);

  const threadRuntimeName = runtimeName(threadRuntime, runtimeBackends);
  const update = !needle && currentRuntime ? runtimeUpdate(currentRuntime.backend) : undefined;
  // A runtime whose models are not on hand: say what choosing it means.
  const elsewhere = !needle && currentRuntime && !currentRuntime.listed ? currentRuntime.backend : undefined;
  // Another runtime's models: what picking one does.
  const foreign = !needle && currentRuntime && currentRuntime.listed && currentRuntime.backend.kind !== threadRuntime ? currentRuntime.backend : undefined;
  const foreignNote = foreign
    ? draft ? `Choosing one runs this thread on ${foreign.label} instead of ${threadRuntimeName}.` : `Choosing one starts a new thread on ${foreign.label}; this one stays on ${threadRuntimeName}.`
    : undefined;
  const foreignEntry = foreign ? catalogs.get(foreign.kind) : undefined;
  const staleNote = foreignEntry?.status === "ready" && foreignEntry.catalog.status ? foreignEntry.catalog.note : undefined;
  const otherRuntime = !draft && currentRuntime && currentRuntime.backend.kind !== threadRuntime && !needle ? currentRuntime.backend : undefined;
  const paneAction = elsewhere && elsewhere.kind !== threadRuntime
    ? draft
      ? { label: `Start this thread on ${elsewhere.label}`, run: () => onSelectRuntime?.(elsewhere.kind) }
      : onNewThreadOnRuntime ? { label: `New thread on ${elsewhere.label}`, run: () => { onNewThreadOnRuntime(elsewhere.kind); onClose(); } } : undefined
    : undefined;

  const choose = (offering: Offering, add = false) => {
    if (offering.runtime !== onHand) {
      multiSelect?.reset();
      preferences.noteModelUsed(offering.key);
      onSelect(offering.model, offering.runtime);
      onClose();
      return;
    }
    if (multiSelect && add) {
      multiSelect.toggle(offering.model, models.find((model) => modelKey(model) === activeKey));
      return;
    }
    multiSelect?.reset();
    preferences.noteModelUsed(offering.key);
    onSelect(offering.model);
    onClose();
  };
  const toggleLegacy = (key: string) => setExpandedLegacy((held) => toggled(held, key.replace(/^legacy:/u, "")));
  const activate = (row: Row | undefined, alt: boolean, add = false) => {
    if (!row || row.kind === "group") return;
    if (row.kind === "legacy") { toggleLegacy(row.key); return; }
    if (alt) preferences.toggleFavouriteModel(row.key);
    else choose(row.offering, add);
  };
  const selectView = (key: string) => {
    setQuery("");
    setMenu(undefined);
    setView(key);
  };
  const stepCursor = (delta: 1 | -1) => {
    if (!rows.some(selectable)) return;
    let next = at < 0 ? (delta === 1 ? -1 : rows.length) : at;
    do next = (next + delta + rows.length) % rows.length; while (!selectable(rows[next]));
    setCursor(next);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/u.test(event.key)) {
      const target = [...jumps].find(([, position]) => position === Number(event.key));
      const offering = target ? byKey.get(target[0]) : undefined;
      if (offering) { event.preventDefault(); choose(offering); }
      return;
    }
    // ⌘⇧↑/↓ as in T3 Code: the next entry of the left column, from anywhere in the picker.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const index = Math.max(0, views.findIndex((entry) => entry.key === current?.key));
      const next = views[(index + (event.key === "ArrowDown" ? 1 : -1) + views.length) % views.length];
      if (next) selectView(next.key);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    if (event.key === "ArrowLeft" && !event.metaKey && !event.ctrlKey && !event.shiftKey && (input.selectionStart ?? 0) === 0 && input.selectionEnd === input.selectionStart) {
      if ((providerColumn && !narrow && focusColumn(providerColumnRef.current)) || focusColumn(runtimeColumnRef.current)) event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowDown") { event.preventDefault(); stepCursor(1); }
    if (event.key === "ArrowUp") { event.preventDefault(); stepCursor(-1); }
    if (event.key === "Enter") {
      event.preventDefault();
      if (paneAction && !rows.length) paneAction.run();
      else activate(rows[at], event.altKey, event.shiftKey);
    }
  };

  const onColumnKeyDown = (column: "runtimes" | "providers") => (event: KeyboardEvent) => {
    const typed = typedCharacter(event);
    if (typed) {
      event.preventDefault();
      setQuery((held) => held + typed);
      inputRef.current?.focus();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      stepColumn(column === "runtimes" ? runtimeColumnRef.current : providerColumnRef.current, event.key === "ArrowDown" ? 1 : -1)?.click();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (column === "providers" || !providerColumn || narrow || !focusColumn(providerColumnRef.current)) inputRef.current?.focus();
    } else if (event.key === "ArrowLeft" && column === "providers") {
      event.preventDefault();
      focusColumn(runtimeColumnRef.current);
    } else if (event.key === "Enter") {
      event.preventDefault();
      (event.target as HTMLElement).click();
      inputRef.current?.focus();
    }
  };

  const viewLabel = (entry: ViewEntry): string => {
    if (entry.kind === "favourites") return "Favourites";
    if (entry.kind === "recent") return "Recent";
    return entry.backend.label;
  };
  // The columns show marks only; the tooltip names the entry and says its state.
  const viewTitle = (entry: ViewEntry): string => {
    if (entry.kind !== "runtime") return viewLabel(entry);
    const note = runtimeUpdate(entry.backend);
    if (entry.listed) return `${entry.backend.label} · ${note?.tag ?? RUNTIME_STATUS_LABELS[entry.status]} · ${countLabel(offerings.filter((offering) => offering.runtime === entry.backend.kind).length)}`;
    if (note) return `${entry.backend.label} · ${note.tag}`;
    if (entry.backend.kind === threadRuntime) return `${entry.backend.label} · this thread's runtime`;
    if (entry.status !== "unlisted") {
      const cached = catalogs.get(entry.backend.kind);
      const message = cached?.status === "unavailable" ? cached.message : undefined;
      return `${entry.backend.label} · ${RUNTIME_STATUS_LABELS[entry.status]}${message ? `\n${message}` : ""}`;
    }
    return draft ? `${entry.backend.label} · run this thread on it` : `${entry.backend.label} · starts a new thread`;
  };
  const inUse = (key: string) => key === activeOffering && chosen.length === 0;
  const cells: RowCell = {
    badges,
    inUse,
    chosen: (key) => chosen.includes(key) ? selectedLabel(chosen, key) : undefined,
    jump: (key) => jumps.get(key),
    onFavourite: (offering) => preferences.toggleFavouriteModel(offering.key),
    onHide: (offering) => preferences.toggleHiddenModel(offering.runtime, modelKey(offering.model)),
    showLegacy: Boolean(needle),
  };
  const listId = "model-picker-list";
  const activeRow = rows[at];

  const providerChoices = providerColumn ? [
    { key: undefined, label: "All providers", count: providerCounts.reduce((sum, [, count]) => sum + count, 0) },
    ...providerCounts.map(([name, count]) => ({ key: name, label: providerLabel(name), count })),
  ] : [];
  const chooseProvider = (key: string | undefined) => {
    if (!currentRuntime) return;
    setQuery("");
    setProviders((held) => ({ ...held, [currentRuntime.backend.kind]: key }));
  };

  const content: ReactNode = (
    <div
      ref={surfaceRef}
      className={`model-picker-content${narrow ? " narrow" : ""}`}
      data-keybinding-context="modelPicker"
      onKeyDown={onKeyDown}
    >
      <div className="model-picker-body">
        <nav ref={runtimeColumnRef} className="model-rail" aria-label="Runtimes" onKeyDown={onColumnKeyDown("runtimes")}>
          {views.map((entry, index) => (
            <div key={entry.key} className="model-rail-slot">
              {index === 1 + (views[1]?.kind === "recent" ? 1 : 0) ? <hr aria-hidden /> : null}
              <button
                data-column-item
                className={!needle && entry.key === current?.key ? "active" : ""}
                aria-label={entry.kind === "runtime" ? `${entry.backend.label}, ${RUNTIME_STATUS_LABELS[entry.status]}` : viewLabel(entry)}
                aria-pressed={!needle && entry.key === current?.key}
                {...tooltipProps(viewTitle(entry), { side: "left", variant: "lines" })}
                tabIndex={!needle && entry.key === current?.key ? 0 : -1}
                onClick={() => selectView(entry.key)}
              >
                {entry.kind === "favourites"
                  ? <Star size={16} fill="currentColor" className="rail-glyph" />
                  : entry.kind === "recent"
                    ? <Clock size={16} className="rail-glyph" />
                    : <ProviderIconStack runtimeProvider={entry.backend.kind === DEFAULT_RUNTIME ? "pi" : entry.backend.kind} className="rail-icon" hint={false} />}
                {entry.kind === "runtime" && entry.backend.kind.includes("@")
                  ? <i className="rail-instance" aria-hidden>{monogram(runtimeInstanceId(entry.backend.kind))}</i>
                  : null}
                {entry.kind === "runtime" ? <i className={`runtime-dot runtime-dot-${entry.status}`} aria-hidden /> : null}
              </button>
            </div>
          ))}
        </nav>

        {providerColumn && !narrow && !needle ? (
          <nav ref={providerColumnRef} className="model-providers" aria-label={`${currentRuntime!.backend.label} providers`} onKeyDown={onColumnKeyDown("providers")}>
            {providerChoices.map((choice) => (
              <button
                key={choice.key ?? "all"}
                data-column-item
                className={choice.key === provider ? "active" : ""}
                aria-pressed={choice.key === provider}
                aria-label={`${choice.label} (${choice.count})`}
                {...tooltipProps(`${choice.label} · ${countLabel(choice.count)}`, { side: "left" })}
                tabIndex={choice.key === provider ? 0 : -1}
                onClick={() => chooseProvider(choice.key)}
              >
                <ProviderChoiceMark provider={choice.key} />
              </button>
            ))}
          </nav>
        ) : null}

        <div className="model-main">
          <div className="palette-input-wrap model-search">
            <Search size={15} />
            <input
              ref={inputRef}
              value={query}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={activeRow && selectable(activeRow) ? `model-option-${at}` : undefined}
              aria-autocomplete="list"
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search all runtimes…"
              aria-label="Search models"
            />
            <div className="model-tool">
              <button
                className={`model-tool-button${sort !== "relevance" ? " on" : ""}`}
                aria-label={`Sort: ${SORT_LABELS[sort]}`}
                title={`Sort by ${SORT_LABELS[sort].toLowerCase()}`}
                aria-haspopup="menu"
                aria-expanded={menu === "sort"}
                onClick={() => setMenu((held) => held === "sort" ? undefined : "sort")}
              >
                <ArrowDownUp size={13} />{narrow ? null : <span>{SORT_LABELS[sort]}</span>}
              </button>
              {menu === "sort" ? (
                <div className="model-menu" role="menu" aria-label="Sort models">
                  {(Object.keys(SORT_LABELS) as OfferingSort[]).map((option) => (
                    <button key={option} role="menuitemradio" aria-checked={sort === option} onClick={() => { setSort(option); setMenu(undefined); inputRef.current?.focus(); }}>
                      {SORT_LABELS[option]}
                      {option === "price" ? <small>plans first</small> : null}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="model-tool">
              <button
                className={`model-tool-button${filterCount(filters) > 0 || showHidden ? " on" : ""}`}
                aria-label={filterCount(filters) > 0 ? `Filter (${filterCount(filters)} on)` : "Filter"}
                title="Filter models"
                aria-haspopup="menu"
                aria-expanded={menu === "filter"}
                onClick={() => setMenu((held) => held === "filter" ? undefined : "filter")}
              >
                <ListFilter size={13} />{filterCount(filters) > 0 ? <span>{filterCount(filters)}</span> : null}
              </button>
              {menu === "filter" ? (
                <div className="model-menu" role="menu" aria-label="Filter models">
                  <span className="model-menu-heading">Billing</span>
                  {BILLING_FILTERS.map(([value, label]) => (
                    <button key={value} role="menuitemcheckbox" aria-checked={filters.billing.has(value)} onClick={() => setFilters((held) => ({ ...held, billing: toggled(held.billing, value) }))}>{label}</button>
                  ))}
                  <span className="model-menu-heading">Can</span>
                  {CAPABILITY_FILTERS.map(([value, label]) => (
                    <button key={value} role="menuitemcheckbox" aria-checked={filters.capabilities.has(value)} onClick={() => setFilters((held) => ({ ...held, capabilities: toggled(held.capabilities, value) }))}>{label}</button>
                  ))}
                  <hr />
                  <button role="menuitemcheckbox" aria-checked={showHidden} onClick={() => setShowHidden((held) => !held)}>Show hidden models</button>
                </div>
              ) : null}
            </div>
            <button
              className="model-provider-add"
              aria-label="Add custom model provider"
              title="Add custom model provider"
              onClick={() => setAddProviderOpen(true)}
            >
              <Plus size={14} />
            </button>
          </div>

          {providerColumn && narrow && !needle ? (
            <div className="model-provider-filter" role="group" aria-label={`${currentRuntime!.backend.label} providers`}>
              {providerChoices.map((choice) => (
                <button
                  key={choice.key ?? "all"}
                  className={choice.key === provider ? "active" : ""}
                  aria-pressed={choice.key === provider}
                  aria-label={`${choice.label} (${choice.count})`}
                  {...tooltipProps(`${choice.label} · ${countLabel(choice.count)}`, { side: "bottom" })}
                  onClick={() => chooseProvider(choice.key)}
                >
                  <ProviderChoiceMark provider={choice.key} />
                </button>
              ))}
            </div>
          ) : null}

          {elsewhere ? (
            <div className="model-runtime-pane" role="region" aria-label={elsewhere.label}>
              <ProviderIconStack runtimeProvider={elsewhere.kind} className="runtime-pane-icon" />
              <strong>{elsewhere.label}</strong>
              <p>{unlistedReason(elsewhere.label, catalogs.get(elsewhere.kind)) ?? (elsewhere.kind === threadRuntime
                ? `This thread starts on ${elsewhere.label} with its default model. Its models are listed once the thread exists.`
                : draft
                  ? `${elsewhere.label} runs the thread instead of ${threadRuntimeName}; choose it to pick one of its models.`
                  : `This thread runs on ${threadRuntimeName}, and a thread keeps the runtime it started on. ${elsewhere.label} runs a thread of its own.`)}</p>
              <div className="model-runtime-pane-actions">
                {paneAction ? <button className="primary" onClick={paneAction.run}>{paneAction.label}</button> : null}
                {otherRuntime ? runtimeActions.map((action) => (
                  <button key={action.id} onClick={() => { action.run(elsewhere.kind); onClose(); }}>{`${action.label} ${elsewhere.label}`}</button>
                )) : null}
              </div>
            </div>
          ) : <>
            {narrow ? null : (
              <div className="model-columns" aria-hidden>
                <span>{needle ? "Model · runtime" : "Model"}</span>
                <span>Context</span>
                <span>Price / MTok</span>
              </div>
            )}
            <VirtualList
              id={listId}
              items={rows}
              itemHeight={rowHeight}
              className="model-list"
              role="listbox"
              ariaLabel={needle ? "Models in every runtime" : current ? `${viewLabel(current)} models` : "Models"}
              scrollToIndex={at >= 0 ? at : undefined}
              empty={<p className="palette-empty">{needle
                ? `No model matches “${query}”.`
                : current?.kind === "favourites" ? "No favourites yet. Star a model to keep it here; ⌘1–9 reach the first nine."
                  : current?.kind === "recent" ? "Nothing chosen yet."
                    : filterCount(filters) > 0 ? "No model passes the filters." : "No models."}</p>}
              renderItem={(row, index) => row.kind === "group"
                ? <div key={row.key} className="model-group" role="presentation"><span>{row.name}</span><small>{row.count} offerings</small></div>
                : row.kind === "legacy"
                  ? <div key={row.key} id={`model-option-${index}`} role="option" aria-selected={index === at} aria-expanded={row.expanded} aria-label={`Legacy models, ${row.count}`} className={`model-row model-legacy ${index === at ? "selected" : ""}`} onMouseMove={() => setCursor(index)} onClick={() => toggleLegacy(row.key)}>
                    <div className="model-cell-main">
                      <span className="model-line"><strong>Legacy models</strong></span>
                      <small className="model-sub">{row.count} {row.count === 1 ? "model" : "models"}</small>
                    </div>
                    <span className="model-chevron">{row.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                  </div>
                  : <OfferingRow
                    key={row.key}
                    id={`model-option-${index}`}
                    offering={row.offering}
                    grouped={row.grouped}
                    cross={row.cross}
                    selected={index === at}
                    narrow={narrow}
                    cells={cells}
                    onPoint={() => setCursor(index)}
                    onChoose={(add) => choose(row.offering, add)}
                  />}
            />
          </>}
        </div>
      </div>

      {foreignNote ? (
        <p className="model-picker-note">
          {foreignNote}
          {draft && foreign ? (
            // The draft moves over with what it last chose there, or the runtime's default.
            <button className="model-note-action" onClick={() => { onSelectRuntime?.(foreign.kind); onClose(); }}>{`Start this thread on ${foreign.label}`}</button>
          ) : null}
          {otherRuntime ? runtimeActions.map((action) => (
            <button key={action.id} className="model-note-action" onClick={() => { action.run(otherRuntime.kind); onClose(); }}>{`${action.label} ${otherRuntime.label}`}</button>
          )) : null}
        </p>
      ) : null}
      {staleNote ? <p className="model-picker-note" role="status">{staleNote}</p> : null}
      {notes.map((note) => <p key={note} className="model-picker-note">{note}</p>)}
      {update ? <p className="model-picker-note" role="status">{update.text}{update.command ? <> {update.verb} <code>{update.command}</code>.</> : null}</p> : null}

      <footer>
        {narrow ? null : <>
          <span>↑↓ move</span>
          <span>←→ columns</span>
          <span>↵ select</span>
          <span>⌥↵ favourite</span>
        </>}
        {multiSelect ? <span>{chosen.length > 1 ? `${chosen.length} models chosen` : "⇧click add a model"}</span> : null}
        <span className="spacer" />
        {hiddenCount > 0 ? (
          <button className="model-footer-link" onClick={() => setShowHidden((held) => !held)}>
            <Eye size={11} /> {showHidden ? `Hide ${hiddenCount} hidden` : `${hiddenCount} hidden · show`}
          </button>
        ) : null}
        <span>{offerings.length} {offerings.length === 1 ? "model" : "models"} · {labels.size} {labels.size === 1 ? "runtime" : "runtimes"}</span>
      </footer>
    </div>
  );
  // Escape or a press outside closes an open menu first.
  const dismiss = () => {
    if (!menu) { onClose(); return; }
    setMenu(undefined);
    inputRef.current?.focus();
  };
  const addProvider = addProviderOpen ? (
    <Suspense fallback={null}>
      <LazyAddModelProviderModal
        onClose={() => setAddProviderOpen(false)}
        onProviderAdded={(newModels) => {
          setAddProviderOpen(false);
          const latest = newModels[newModels.length - 1];
          if (latest) {
            setView(runtimeView(onHand));
            setProviders((held) => ({ ...held, [onHand]: latest.provider }));
          }
        }}
      />
    </Suspense>
  ) : null;

  // A press in the form would count as outside the popover, so the form takes the popover's place.
  return addProvider ?? (
    <Popover anchor={anchor} side={side} align="start" label="Select model" className="model-picker" onClose={dismiss}>
      {content}
    </Popover>
  );
}
