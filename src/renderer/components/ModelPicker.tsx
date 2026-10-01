import { lazy, Suspense, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { ChevronDown, ChevronRight, ChevronUp, CornerDownRight, History, Search, SlidersHorizontal, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel, UiRuntimeBackend } from "../../shared/contracts";
import type { ModelBadgeContribution, ModelSelectionContribution } from "../extension-system";
import { catalogLevels, type RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { withPriceOverride } from "../../shared/model-prices";
import { modelPresentation } from "../model-manifest";
import { getHostClient } from "../host-client-context";
import { usePreferences } from "../renderer-services-context";
import { DEFAULT_RUNTIME, modelOnPlan } from "../runtime-marks";
import { runtimeInstanceId } from "../../shared/runtime-instances";
import { runtimeUpdate } from "../runtime-update";
import {
  FAVOURITES_VIEW, RUNTIME_STATUS_LABELS, makerView, pickerRuntimes, pickerViews, runtimeView, type RuntimeEntry, type RuntimeStatus, type ViewEntry,
} from "./model-picker-rail";
import {
  NO_FILTERS, filterCount, modelFamily, modelKey, offeringKey, orderedPositions, passesFilters, searchOfferings,
  offeringComparator, type BillingFilter, type CapabilityFilter, type Offering, type OfferingFilters, type OfferingSort,
} from "./model-offerings";
import { MAKER_ORDER, modelEntries, modelMaker, type ModelEntry } from "./model-entries";
import { EntryRow, modelFacts, wears, type RowCell } from "./ModelPickerRow";
import { ProviderIconStack, monogram, providerLabel, providerStackLabel } from "./ProviderIconStack";
import { Popover } from "./ui/Dialog";
import { placeFloating, viewportSize } from "./ui/floating";
import { useFocusTrap } from "./ui/focus";
import { WorkbenchShellContext } from "../workbench-context";
import { tooltipProps } from "./ui/Tooltip";
import { VirtualList } from "./VirtualList";
import { useCompactForm } from "../use-layout-profile";
import { useSheetDrag } from "../touch/sheet-drag";
import "./model-picker.css";

const LazyAddModelProviderModal = lazy(() => import("./AddModelProviderModal").then(({ AddModelProviderModal }) => ({ default: AddModelProviderModal })));

/** ⌘1 to ⌘9 reach the first nine favourites, in the order they were starred. */
const JUMP_KEYS = 9;
/** Below these widths the rail goes above the list. */
const STACK_WIDTH = 560;
const SHEET_STACK_WIDTH = 700;
/** A maker with more models than this and none pinned still folds behind "Show all". */
const FOLD_UNPINNED = 8;
/** The pointer has to rest on a row this long to make it the one "Runs with" is for; passing over on the way down does not. */
const POINT_REST_MS = 110;
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

/** One line of the list: a model with the way it was listed for (a favourite's, a recent one's), or a fold. */
type Row =
  | { kind: "entry"; key: string; entry: ModelEntry; way?: Offering }
  | { kind: "legacy" | "more"; key: string; count: number; expanded: boolean };

const rowHeight = (row: Row): number => row.kind === "entry" ? 46 : 30;
/** On a phone every row that can be tapped is at least a finger (44 px) high. */
const touchRowHeight = (row: Row): number => row.kind === "entry" ? 58 : 44;

const SORT_LABELS: Record<OfferingSort, string> = { relevance: "Relevance", price: "Price", context: "Context", newest: "Newest" };
const BILLING_FILTERS: ReadonlyArray<[BillingFilter, string]> = [["subscription", "Plan"], ["api", "API key"], ["free", "Free or local"]];
const CAPABILITY_FILTERS: ReadonlyArray<[CapabilityFilter, string]> = [["images", "Reads images"], ["reasoning", "Reasoning"]];
/** A runtime in one of these states cannot run a thread yet: dimmed, with the reason and a way to fix it. */
const BLOCKED: ReadonlySet<RuntimeStatus> = new Set(["not-installed", "sign-in", "unavailable"]);
const BILLING_RANK: Record<string, number> = { subscription: 0, "api-key": 1, free: 2, local: 3 };

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

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`;
}

const billingOf = (way: Offering) => way.model.billing ?? (way.model.login === "subscription" ? "subscription" : undefined);

/** How a way is had: "Plan", "API key", "Free" through the maker itself; a gateway by its name. */
export function wayText(way: Offering): string {
  const billing = billingOf(way);
  const own = modelMaker({ provider: way.model.provider, id: "" }) === modelMaker(way.model) || way.model.provider === way.runtime;
  if (!own) return providerLabel(way.model.provider);
  return billing === "subscription" ? "Plan" : billing === "free" ? "Free" : billing === "local" ? "Local" : "API key";
}

function useStacked(asSheet: boolean): boolean {
  const limit = asSheet ? SHEET_STACK_WIDTH : STACK_WIDTH;
  const [stacked, setStacked] = useState(() => typeof window !== "undefined" && window.innerWidth > 0 && window.innerWidth < limit);
  useEffect(() => {
    const update = () => setStacked(window.innerWidth > 0 && window.innerWidth < limit);
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, [limit]);
  return stacked;
}

function toggled<T>(set: ReadonlySet<T>, value: T): Set<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}

/** A printable key typed while the rail or "Runs with" has focus belongs in the search field. */
function typedCharacter(event: KeyboardEvent): string | undefined {
  return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && event.key !== " " ? event.key : undefined;
}

/** Moves focus to the previous or next button of a group and returns it. */
function stepColumn(column: HTMLElement | null, delta: 1 | -1): HTMLButtonElement | undefined {
  const buttons = [...column?.querySelectorAll<HTMLButtonElement>("button[data-column-item]:not(:disabled)") ?? []];
  if (buttons.length === 0) return undefined;
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  const next = buttons[(index + delta + buttons.length) % buttons.length];
  next?.focus();
  return next;
}

function focusColumn(column: HTMLElement | null): boolean {
  const button = column?.querySelector<HTMLButtonElement>("button[data-column-item][data-current]") ?? column?.querySelector<HTMLButtonElement>("button[data-column-item]:not(:disabled)");
  button?.focus();
  return Boolean(button);
}

/**
 * The model picker (K142, concept B): the rail lists who made the models,
 * each model is one row, and "Runs with" under the list offers every way to
 * run the highlighted one — a runtime and how it is paid. Thinking, context
 * window and speed are the composer's own chip, not the picker's.
 */
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
  onOpenSettings: openSettings,
  thinkingSummary,
  onOpenThinking,
  anchor,
  placeAgainst,
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
  /** Every runtime the host offers. */
  runtimeBackends?: readonly UiRuntimeBackend[];
  /** The host's catalogs of every runtime, so another runtime's ways are offered too. */
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
  /**
   * Settings for a runtime: its card, to install or sign in ("runtime"), or its models, to pin them ("models").
   * By default the workbench's own Settings: the runtime's card under Providers, and its models there.
   */
  onOpenSettings?(kind: ThreadBackendKind, part: "runtime" | "models"): void;
  /** The phone sheet's last row ("Thinking and speed"): what the thinking chip says, and opening its sheet. */
  thinkingSummary?: ReactNode;
  onOpenThinking?(): void;
  /** The control that opens the picker; the picker opens at it. */
  anchor: RefObject<HTMLElement | null>;
  /** Where it opens when not at the anchor: the composer's frame, its left edge and 6 px above (design 1l). */
  placeAgainst?: RefObject<HTMLElement | null>;
  /** Where it prefers to open; it flips when that side has no room. */
  side?: "top" | "bottom";
}) {
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const shell = useContext(WorkbenchShellContext);
  // Phones use a bottom sheet; tablets keep the bounded popover and touch-sized rows.
  const [compact] = useState(() => typeof document !== "undefined" && document.body.dataset.profile === "compact");
  const form = useCompactForm(compact ? "compact" : "desktop");
  const asSheet = compact && form === "single";
  // A phone's Settings has no runtime cards to sign in on; there the reason stands alone.
  const onOpenSettings = openSettings ?? (shell?.actions && !compact ? (kind: ThreadBackendKind, part: "runtime" | "models") => {
    const card = shell.registry.getSettingsPages().find((page) => page.runtime === kind)?.id;
    shell.actions!.openSettings(part === "models" ? `providers#runtime-models-${kind}` : card ?? "providers");
  } : undefined);
  const onHand = catalogRuntime ?? DEFAULT_RUNTIME;
  const threadRuntime = runtime ?? onHand;
  const draft = onSelectRuntime !== undefined;
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<OfferingSort>("relevance");
  const [filters, setFilters] = useState<OfferingFilters>(NO_FILTERS);
  const [showHidden, setShowHidden] = useState(false);
  const [menu, setMenu] = useState<"options">();
  const [refreshing, setRefreshing] = useState(false);
  // A CLI updated behind Tau's back names its new models only when asked again.
  const refreshModels = getHostClient()?.runtimeTools;
  const [cursor, setCursor] = useState<number>();
  const [expandedLegacy, setExpandedLegacy] = useState<ReadonlySet<string>>(() => new Set());
  const [expandedAll, setExpandedAll] = useState<ReadonlySet<string>>(() => new Set());
  // The way chosen in "Runs with" for a row, until another is.
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stacked = useStacked(asSheet);
  const sheetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { sheetRef.current = asSheet ? surfaceRef.current?.closest<HTMLElement>(".model-picker") ?? null : null; }, [asSheet]);
  const railRef = useRef<HTMLElement>(null);
  const waysRef = useRef<HTMLDivElement>(null);
  const pointTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(pointTimer.current), []);
  const chosen = useSyncExternalStore(
    multiSelect?.subscribe ?? noSubscription,
    () => multiSelect?.selected() ?? NO_SELECTION,
    () => NO_SELECTION,
  );

  const runtimes = useMemo(() => pickerRuntimes(onHand, runtimeBackends, catalogs), [catalogs, onHand, runtimeBackends]);
  const activeOffering = activeKey && threadRuntime === onHand ? (onHand === DEFAULT_RUNTIME ? activeKey : `${onHand}:${activeKey}`) : undefined;

  // Every offering of every runtime whose models are on hand: the thread's own catalog, the host's for the rest.
  const offerings = useMemo<Offering[]>(() => {
    const favourites = new Set(settings.favouriteModels);
    const result: Offering[] = [];
    for (const entry of runtimes) {
      if (!entry.listed) continue;
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
          levels: catalogLevels(catalog, model),
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
  }, [catalogs, models, onHand, runtimes, settings.favouriteModels, settings.modelPreferences, settings.modelPrices]);
  const byKey = useMemo(() => new Map(offerings.map((offering) => [offering.key, offering] as const)), [offerings]);
  const jumps = useMemo(() => {
    const map = new Map<string, number>();
    for (const key of settings.favouriteModels) {
      if (map.size >= JUMP_KEYS) break;
      if (byKey.has(key)) map.set(key, map.size + 1);
    }
    return map;
  }, [byKey, settings.favouriteModels]);

  const needle = query.trim();
  const visible = useMemo(
    () => offerings.filter((offering) => (showHidden || !offering.hidden || offering.key === activeOffering) && passesFilters(offering, filters)),
    [activeOffering, filters, offerings, showHidden],
  );
  const entries = useMemo(() => modelEntries(visible, activeOffering), [activeOffering, visible]);
  const entryOf = useMemo(() => {
    const byFamily = new Map(entries.map((entry) => [entry.key, entry] as const));
    return (offering: Offering) => byFamily.get(modelFamily(offering.model));
  }, [entries]);
  const views = useMemo(() => pickerViews(entries.map((entry) => entry.maker), runtimes, providerLabel), [entries, runtimes]);
  const [view, setView] = useState(() => {
    const active = activeOffering ? byKey.get(activeOffering) : undefined;
    if (active) return makerView(modelMaker(active.model));
    const own = runtimes.find((entry) => entry.backend.kind === threadRuntime);
    return own && !own.listed ? runtimeView(threadRuntime) : views.find((entry) => entry.kind === "maker")?.key ?? FAVOURITES_VIEW;
  });
  const current = views.find((entry) => entry.key === view) ?? views.find((entry) => entry.kind === "maker") ?? views[0]!;
  const recentRank = useMemo(() => new Map(settings.recentModels.map((key, index) => [key, index] as const)), [settings.recentModels]);
  const runtimeOrder = useMemo(() => new Map(runtimes.map((entry, index) => [entry.backend.kind, index] as const)), [runtimes]);

  /** The way a row offers first: the model in use, the thread's runtime, a pinned way, the last one used, a plan. */
  const bestWay = (entry: ModelEntry): Offering => {
    const score = (way: Offering) => way.key === activeOffering ? 0
      : !draft && way.runtime === threadRuntime ? 1
      : way.favourite ? 2
      : recentRank.has(way.key) ? 3 + recentRank.get(way.key)! / 100
      : 4 + (billingOf(way) === "subscription" ? 0 : 1) + (way.runtime === threadRuntime ? 0 : 0.5);
    return [...entry.ways].sort((a, b) => score(a) - score(b))[0]!;
  };
  const wayOf = (row: Extract<Row, { kind: "entry" }>): Offering => {
    const chosenWay = picked[row.key];
    return row.entry.ways.find((way) => way.key === chosenWay) ?? row.way ?? bestWay(row.entry);
  };

  const rows = useMemo<Row[]>(() => {
    const entryRow = (entry: ModelEntry, way?: Offering): Row => ({ kind: "entry", key: way ? way.key : entry.key, entry, ...(way ? { way } : {}) });
    const compare = offeringComparator(sort);
    const sorted = (list: readonly ModelEntry[]) => sort === "relevance" ? [...list] : [...list].sort((a, b) => compare(a.ways[0]!, b.ways[0]!));
    if (needle) {
      return searchOfferings(visible, needle, sort, providerLabel, threadRuntime).flatMap((group) => modelEntries(group, activeOffering).map((entry) => entryRow(entry)));
    }
    if (current.kind === "favourites" || current.kind === "recent") {
      const keys = current.kind === "favourites" ? settings.favouriteModels : settings.recentModels;
      return keys.flatMap((key) => {
        const offering = byKey.get(key);
        const entry = offering && visible.includes(offering) ? entryOf(offering) : undefined;
        return entry && offering ? [entryRow(entry, entry.ways.find((way) => way.key === key) ?? offering)] : [];
      });
    }
    if (current.kind !== "maker") return [];
    // The first runtime's order (the user's, where set), then the next runtime's for what only it runs.
    const scoped = sorted(entries.filter((entry) => entry.maker === current.maker).sort((a, b) => (runtimeOrder.get(a.ways[0]!.runtime) ?? 99) - (runtimeOrder.get(b.ways[0]!.runtime) ?? 99) || a.ways[0]!.position - b.ways[0]!.position));
    const group = current.key;
    const isLegacy = (entry: ModelEntry) => entry.ways.every((way) => way.legacy);
    // The legacy fold is the catalog's own order's; a sort or filter lists everything.
    const withLegacy = (list: readonly ModelEntry[]): Row[] => {
      const legacy = list.filter(isLegacy);
      if (legacy.length === 0 || sort !== "relevance" || filterCount(filters) > 0) return list.map((entry) => entryRow(entry));
      const expanded = expandedLegacy.has(group) || legacy.some((entry) => entry.ways.some((way) => way.key === activeOffering));
      return [
        ...list.filter((entry) => !isLegacy(entry)).map((entry) => entryRow(entry)),
        { kind: "legacy", key: `legacy:${group}`, count: legacy.length, expanded },
        ...(expanded ? legacy.map((entry) => entryRow(entry)) : []),
      ];
    };
    if (sort !== "relevance" || filterCount(filters) > 0) return withLegacy(scoped);
    // Pinned first: the favourites, the model in use and the ones used lately; the rest behind "Show all".
    const pinned = scoped.filter((entry) => entry.ways.some((way) => way.favourite || way.key === activeOffering || recentRank.has(way.key)));
    const rest = scoped.filter((entry) => !pinned.includes(entry));
    const folds = pinned.length > 0 && rest.length > 0 && (pinned.some((entry) => entry.ways.some((way) => way.favourite)) || scoped.length > FOLD_UNPINNED);
    if (!folds) return withLegacy(scoped);
    const open = expandedAll.has(group);
    return [
      ...pinned.map((entry) => entryRow(entry)),
      { kind: "more", key: `more:${group}`, count: scoped.length, expanded: open },
      ...(open ? withLegacy(rest) : []),
    ];
  }, [activeOffering, byKey, current, entries, entryOf, expandedAll, expandedLegacy, filters, needle, recentRank, runtimeOrder, settings.favouriteModels, settings.recentModels, sort, threadRuntime, visible]);

  // The cursor starts on the model in use, else on the first row.
  const initialCursor = useMemo(() => {
    const index = activeOffering ? rows.findIndex((row) => row.kind === "entry" && row.entry.ways.some((way) => way.key === activeOffering)) : -1;
    return index >= 0 && !needle ? index : rows.findIndex((row) => row.kind === "entry");
  }, [activeOffering, needle, rows]);
  useEffect(() => setCursor(undefined), [needle, view, sort, filters]);
  const at = cursor !== undefined && rows[cursor] ? cursor : initialCursor;
  const activeRow = rows[at];
  const highlighted = activeRow?.kind === "entry" ? activeRow : undefined;
  const highlightedWay = highlighted ? wayOf(highlighted) : undefined;

  // Again after the add-provider form, which a popover picker gives its place to.
  useEffect(() => {
    if (!addProviderOpen) requestAnimationFrame(() => inputRef.current?.focus());
  }, [addProviderOpen]);
  useFocusTrap(surfaceRef, !addProviderOpen);

  const notes = useMemo(() => {
    const listed = rows.flatMap((row) => row.kind === "entry" ? row.entry.ways : []);
    return [...new Set(badges.filter((badge) => badge.note && listed.some((offering) => wears(badge, offering.model, offering.runtime))).map((badge) => badge.note as string))];
  }, [badges, rows]);

  const runtimeName = (kind: ThreadBackendKind) => runtimes.find((entry) => entry.backend.kind === kind)?.backend.label ?? (kind === DEFAULT_RUNTIME ? "Pi" : kind);
  const threadRuntimeName = runtimeName(threadRuntime);
  const fixAction = (blocked: RuntimeEntry) => onOpenSettings ? {
    label: blocked.status === "not-installed" ? `Install ${blocked.backend.label}…` : blocked.status === "sign-in" ? `Sign in to ${blocked.backend.label}…` : `${blocked.backend.label} settings`,
    run: () => { onOpenSettings(blocked.backend.kind, "runtime"); onClose(); },
  } : undefined;
  // A runtime whose models are not on hand: say what choosing it means.
  const elsewhere = !needle && current.kind === "runtime" ? current : undefined;
  const elsewhereFix = elsewhere && BLOCKED.has(elsewhere.status) ? fixAction(elsewhere) : undefined;
  const newThreadAction = !draft && onNewThreadOnRuntime && elsewhere && elsewhere.backend.kind !== threadRuntime && !BLOCKED.has(elsewhere.status)
    ? { label: `New thread on ${elsewhere.backend.label}`, run: () => { onNewThreadOnRuntime(elsewhere.backend.kind); onClose(); } }
    : undefined;
  const kitActions = !draft && elsewhere && elsewhere.backend.kind !== threadRuntime && !BLOCKED.has(elsewhere.status) ? elsewhere.backend : undefined;
  // Another runtime's catalog from before its program changed says so for its way.
  const wayCatalog = highlightedWay && highlightedWay.runtime !== threadRuntime ? catalogs.get(highlightedWay.runtime) : undefined;
  const staleNote = wayCatalog?.status === "ready" && wayCatalog.catalog.status ? wayCatalog.catalog.note : undefined;
  const wayBackend = highlightedWay ? runtimes.find((entry) => entry.backend.kind === highlightedWay.runtime)?.backend : undefined;
  const update = wayBackend ? runtimeUpdate(wayBackend) : undefined;

  /** Applies `way`. A sheet stays open while the thread stays where it is, so a way or Thinking can follow. */
  const choose = (way: Offering, add = false) => {
    if (multiSelect && add) {
      multiSelect.toggle(way.model, models.find((model) => modelKey(model) === activeKey), way.runtime, onHand);
      return;
    }
    multiSelect?.reset();
    preferences.noteModelUsed(way.key);
    const moves = way.runtime !== onHand;
    if (moves) onSelect(way.model, way.runtime);
    else onSelect(way.model);
    if (!asSheet || (moves && !draft)) onClose();
  };
  const toggleFold = (row: Extract<Row, { kind: "legacy" | "more" }>) => {
    if (row.kind === "legacy") setExpandedLegacy((held) => toggled(held, row.key.replace(/^legacy:/u, "")));
    else setExpandedAll((held) => toggled(held, row.key.replace(/^more:/u, "")));
  };
  const activate = (row: Row | undefined, alt: boolean, add = false) => {
    if (!row) return;
    if (row.kind !== "entry") { toggleFold(row); return; }
    const way = wayOf(row);
    if (alt) preferences.toggleFavouriteModel(way.key);
    else choose(way, add);
  };
  const selectView = (entry: ViewEntry) => {
    setQuery("");
    setMenu(undefined);
    setView(entry.key);
    // A draft moves to a runtime that lists no models, with its default model.
    if (draft && entry.kind === "runtime" && entry.backend.kind !== threadRuntime && !BLOCKED.has(entry.status) && entry.status !== "loading") {
      onSelectRuntime?.(entry.backend.kind);
    }
  };
  const stepCursor = (delta: 1 | -1) => {
    if (rows.length === 0) return;
    setCursor(at < 0 ? (delta === 1 ? 0 : rows.length - 1) : (at + delta + rows.length) % rows.length);
  };
  const point = (index: number) => {
    clearTimeout(pointTimer.current);
    pointTimer.current = setTimeout(() => setCursor(index), POINT_REST_MS);
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if ((event.metaKey || event.ctrlKey) && /^[1-9]$/u.test(event.key)) {
      const target = [...jumps].find(([, position]) => position === Number(event.key));
      const offering = target ? byKey.get(target[0]) : undefined;
      if (offering) { event.preventDefault(); choose(offering); }
      return;
    }
    // ⌘⇧↑/↓: the next entry of the rail, from anywhere in the picker.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const index = Math.max(0, views.findIndex((entry) => entry.key === current.key));
      const next = views[(index + (event.key === "ArrowDown" ? 1 : -1) + views.length) % views.length];
      if (next) selectView(next);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const collapsed = input.selectionEnd === input.selectionStart;
    const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.key === "ArrowLeft" && plain && collapsed && (input.selectionStart ?? 0) === 0) {
      if (focusColumn(railRef.current)) event.preventDefault();
      return;
    }
    // Tab, or → at the end of the text: into "Runs with".
    if ((event.key === "Tab" && plain) || (event.key === "ArrowRight" && plain && collapsed && (input.selectionStart ?? 0) === input.value.length)) {
      if (focusColumn(waysRef.current)) event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowDown") { event.preventDefault(); stepCursor(1); }
    if (event.key === "ArrowUp") { event.preventDefault(); stepCursor(-1); }
    if (event.key === "Enter") {
      event.preventDefault();
      if (rows.length) activate(rows[at], event.altKey, event.shiftKey);
      else (elsewhereFix ?? newThreadAction)?.run();
    }
  };

  const onRailKeyDown = (event: KeyboardEvent) => {
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
      // An entry is shown as the arrow reaches it.
      stepColumn(railRef.current, event.key === "ArrowDown" ? 1 : -1)?.click();
    } else if (event.key === "ArrowRight" || event.key === "Enter") {
      event.preventDefault();
      if (event.key === "Enter") (event.target as HTMLElement).click();
      inputRef.current?.focus();
    }
  };

  const onWaysKeyDown = (event: KeyboardEvent) => {
    const typed = typedCharacter(event);
    if (typed) {
      event.preventDefault();
      setQuery((held) => held + typed);
      inputRef.current?.focus();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next = stepColumn(waysRef.current, event.key === "ArrowRight" ? 1 : -1);
      const key = next?.dataset.way;
      if (key && highlighted) setPicked((held) => ({ ...held, [highlighted.key]: key }));
    } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      inputRef.current?.focus();
      stepCursor(event.key === "ArrowDown" ? 1 : -1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const key = (event.target as HTMLElement).dataset.way;
      const way = key ? byKey.get(key) : undefined;
      if (way) choose(way, event.shiftKey);
    }
  };

  const viewLabel = (entry: ViewEntry): string => {
    if (entry.kind === "favourites") return "Favourites";
    if (entry.kind === "recent") return "Recent";
    if (entry.kind === "maker") return providerLabel(entry.maker);
    return entry.backend.label;
  };
  // The rail shows marks only; the tooltip names the entry and says its state.
  const viewTitle = (entry: ViewEntry): string => {
    if (entry.kind === "favourites") return "Favourites · each with the way it was pinned";
    if (entry.kind === "recent") return "Recent · the last ways used";
    if (entry.kind === "maker") {
      const count = entries.filter((item) => item.maker === entry.maker).length;
      return `${providerLabel(entry.maker)} · ${countLabel(count)}${MAKER_ORDER.includes(entry.maker) ? "" : " of its own"}`;
    }
    const note = runtimeUpdate(entry.backend);
    if (note) return `${entry.backend.label} · ${note.tag}`;
    if (entry.backend.kind === threadRuntime) return `${entry.backend.label} · this thread's runtime`;
    if (entry.status !== "unlisted") {
      const cached = catalogs.get(entry.backend.kind);
      const message = cached?.status === "unavailable" ? cached.message : undefined;
      return `${entry.backend.label} · ${RUNTIME_STATUS_LABELS[entry.status]}${message ? `\n${message}` : ""}`;
    }
    return draft ? `${entry.backend.label} · run this thread on it` : `${entry.backend.label} · starts a new thread`;
  };
  const cells: RowCell = {
    badges,
    inUse: (entry) => chosen.length === 0 && entry.ways.some((way) => way.key === activeOffering),
    chosen: (way) => {
      const selected = `${way.runtime}::${modelKey(way.model)}`;
      const legacy = modelKey(way.model);
      return chosen.includes(selected) ? selectedLabel(chosen, selected) : chosen.includes(legacy) ? selectedLabel(chosen, legacy) : undefined;
    },
    jump: (key) => jumps.get(key),
    onFavourite: (way) => preferences.toggleFavouriteModel(way.key),
    onHide: (entry) => {
      const hide = !entry.ways.every((way) => way.hidden);
      for (const way of entry.ways) if (way.hidden !== hide) preferences.toggleHiddenModel(way.runtime, modelKey(way.model));
    },
    showLegacy: Boolean(needle),
  };
  const listId = "model-picker-list";
  const optionsOn = filterCount(filters) + (sort === "relevance" ? 0 : 1) + (showHidden ? 1 : 0);
  const heading = needle ? `Every provider · ${rows.length} ${rows.length === 1 ? "match" : "matches"}` : viewLabel(current);

  // "Runs with" for the highlighted row: the thread's runtime first, then the host's order, a plan before a key.
  const ways = highlighted ? [...highlighted.entry.ways].sort((a, b) => (a.runtime === threadRuntime ? -1 : 0) - (b.runtime === threadRuntime ? -1 : 0)
    || (runtimeOrder.get(a.runtime) ?? 99) - (runtimeOrder.get(b.runtime) ?? 99)
    || (BILLING_RANK[billingOf(a) ?? ""] ?? 4) - (BILLING_RANK[billingOf(b) ?? ""] ?? 4)) : [];
  // A thread that exists keeps its runtime: when that one cannot run the model, it stands first, greyed.
  const cannot = !draft && highlighted && !ways.some((way) => way.runtime === threadRuntime) ? threadRuntime : undefined;
  // From E: a runtime of the model's maker that is not ready yet offers what makes it ready.
  const blockedWays = highlighted ? runtimes.filter((entry) => BLOCKED.has(entry.status)
    && (entry.backend.homeProviders ?? []).some((provider) => modelMaker({ provider, id: "" }) === highlighted.entry.maker)) : [];
  const leaves = !draft && highlightedWay && highlightedWay.runtime !== threadRuntime ? highlightedWay : undefined;
  const carries = leaves && runtimeActions.length > 0;
  const waysBar = highlighted && highlightedWay ? (
    <footer className="model-ways-bar" aria-live="polite">
      <div className="model-ways-row">
        <span className="model-ways-label">Runs with</span>
        <div ref={waysRef} className="model-ways" role="radiogroup" aria-label={`Runs with, ${highlighted.entry.name}`} onKeyDown={onWaysKeyDown}>
          {cannot ? (
            <button type="button" className="model-way cannot" disabled aria-label={`${runtimeName(cannot)}, can't run it`} {...tooltipProps(`${runtimeName(cannot)} runs this thread and cannot run ${highlighted.entry.name}`)}>
              <ProviderIconStack runtimeProvider={cannot} className="way-icon" hint={false} />can't run it
            </button>
          ) : null}
          {ways.map((way) => {
            const on = way.key === highlightedWay.key;
            const text = wayText(way);
            return (
              <button
                key={way.key}
                type="button"
                role="radio"
                aria-checked={on}
                aria-label={`${way.runtimeLabel}, ${text}`}
                className={`model-way${on ? " on" : ""}`}
                data-column-item
                data-way={way.key}
                {...(on ? { "data-current": "" } : {})}
                tabIndex={on ? 0 : -1}
                {...tooltipProps(`${providerStackLabel(way.model.provider, way.runtime, { plan: modelOnPlan(way.model) })}${way.runtime === threadRuntime || draft ? "" : " · a new thread"}`)}
                onClick={(event) => { setPicked((held) => ({ ...held, [highlighted.key]: way.key })); choose(way, event.shiftKey); }}
              >
                <ProviderIconStack runtimeProvider={way.runtime} runtimeName={way.runtimeLabel} className="way-icon" hint={false} />
                {text}
                {jumps.has(way.key) ? <Star size={10} fill="currentColor" className="way-star" aria-hidden /> : null}
              </button>
            );
          })}
          {blockedWays.map((entry) => {
            const fix = fixAction(entry);
            return (
              <button key={entry.backend.kind} type="button" className="model-way cannot" disabled={!fix} aria-label={fix?.label.replace(/…$/u, "") ?? `${entry.backend.label}, ${RUNTIME_STATUS_LABELS[entry.status]}`} {...tooltipProps(`${entry.backend.label} · ${RUNTIME_STATUS_LABELS[entry.status]}`)} onClick={fix?.run}>
                <ProviderIconStack runtimeProvider={entry.backend.kind} className="way-icon" hint={false} />
                {entry.status === "not-installed" ? "Install" : entry.status === "sign-in" ? "Sign in" : "Unavailable"}
              </button>
            );
          })}
        </div>
        {stacked || compact ? null : <span className="model-keys keyboard-hint" aria-hidden>Tab ←→</span>}
      </div>
      <p className="model-ways-note">
        {leaves ? <>
          <CornerDownRight size={13} className="model-ways-glyph" aria-hidden />
          <span>This thread runs with {threadRuntimeName}. <b>{compact ? "Choosing it" : "↵"} {carries ? "continues in a new thread" : "starts a new thread"}</b> with {leaves.runtimeLabel}{carries ? ", carrying a summary" : ""}.</span>
        </> : [providerStackLabel(highlightedWay.model.provider, highlightedWay.runtime, { plan: modelOnPlan(highlightedWay.model) }), ...modelFacts(highlightedWay.model, highlightedWay.customPrice)].join(" · ")}
      </p>
    </footer>
  ) : null;

  const content: ReactNode = (
    <div
      ref={surfaceRef}
      className={`model-picker-content${stacked ? " stacked" : ""}`}
      data-keybinding-context="modelPicker"
      onKeyDown={onKeyDown}
    >
      {asSheet ? <header className="touch-sheet-header">
        <span className="touch-sheet-grip" aria-hidden="true" />
        <strong>Model</strong>
        <button type="button" className="model-sheet-done" onClick={onClose}>Done</button>
      </header> : null}
      <div className="palette-input-wrap model-search">
        <Search size={15} />
        <input
          ref={inputRef}
          value={query}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={activeRow ? `model-option-${at}` : undefined}
          aria-autocomplete="list"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onSearchKeyDown}
          placeholder={compact ? "Model or provider" : "Search models…"}
          aria-label="Search models"
        />
        {stacked ? null : <span className="model-keys keyboard-hint" aria-hidden {...tooltipProps(`↑↓ move · Tab Runs with · ↵ choose · ⌥↵ pin${multiSelect ? " · ⇧click adds a model" : ""}`, { side: "bottom" })}>↑↓ ↵</span>}
        <div className="model-tool">
          <button
            className={`model-tool-button${optionsOn > 0 ? " on" : ""}`}
            aria-label={optionsOn > 0 ? `Sort and filter (${optionsOn} on)` : "Sort and filter"}
            {...tooltipProps("Sort, filter, hidden models, providers", { side: "bottom" })}
            aria-haspopup="menu"
            aria-expanded={menu === "options"}
            onClick={() => setMenu((held) => held ? undefined : "options")}
          >
            <SlidersHorizontal size={14} />{optionsOn > 0 ? <span>{optionsOn}</span> : null}
          </button>
          {menu === "options" ? (
            <div className="model-menu" role="menu" aria-label="Sort and filter models">
              <span className="model-menu-heading">Sort</span>
              {(Object.keys(SORT_LABELS) as OfferingSort[]).map((option) => (
                <button key={option} role="menuitemradio" aria-checked={sort === option} onClick={() => { setSort(option); setMenu(undefined); inputRef.current?.focus(); }}>
                  {SORT_LABELS[option]}
                  {option === "price" ? <small>plans first</small> : null}
                </button>
              ))}
              <span className="model-menu-heading">Billing</span>
              {BILLING_FILTERS.map(([value, label]) => (
                <button key={value} role="menuitemcheckbox" aria-checked={filters.billing.has(value)} onClick={() => setFilters((held) => ({ ...held, billing: toggled(held.billing, value) }))}>{label}</button>
              ))}
              <span className="model-menu-heading">Can</span>
              {CAPABILITY_FILTERS.map(([value, label]) => (
                <button key={value} role="menuitemcheckbox" aria-checked={filters.capabilities.has(value)} onClick={() => setFilters((held) => ({ ...held, capabilities: toggled(held.capabilities, value) }))}>{label}</button>
              ))}
              <hr />
              <button role="menuitemcheckbox" aria-checked={showHidden} onClick={() => setShowHidden((held) => !held)}>
                Show hidden models{offerings.some((offering) => offering.hidden) ? <small>{offerings.filter((offering) => offering.hidden).length}</small> : null}
              </button>
              <button role="menuitem" onClick={() => { setMenu(undefined); setAddProviderOpen(true); }}>Add model provider…</button>
              {onOpenSettings ? <button role="menuitem" onClick={() => { onOpenSettings(highlightedWay?.runtime ?? threadRuntime, "models"); onClose(); }}>Pin models in Settings…</button> : null}
              {refreshModels ? (
                <button role="menuitem" disabled={refreshing} title="Ask every runtime for its version and models again" onClick={() => {
                  setRefreshing(true);
                  void refreshModels("refresh").catch(() => undefined).finally(() => setRefreshing(false));
                }}>{refreshing ? "Refreshing…" : "Refresh models"}</button>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>

      <div className="model-picker-body">
        <nav ref={railRef} className="model-rail" aria-label="Providers" onKeyDown={onRailKeyDown}>
          {views.map((entry, index) => {
            const on = !needle && entry.key === current.key;
            const blocked = entry.kind === "runtime" && BLOCKED.has(entry.status);
            const ruled = index === 2 || (entry.kind === "runtime" && views[index - 1]?.kind !== "runtime");
            return (
              <div key={entry.key} className="model-rail-slot">
                {ruled ? <hr aria-hidden /> : null}
                <button
                  data-column-item
                  {...(on ? { "data-current": "" } : {})}
                  className={`${on ? "active" : ""}${blocked ? " blocked" : ""}`}
                  aria-label={entry.kind === "runtime" ? `${entry.backend.label}, ${RUNTIME_STATUS_LABELS[entry.status]}` : viewLabel(entry)}
                  aria-pressed={on}
                  {...tooltipProps(viewTitle(entry), { side: stacked ? "bottom" : "left", variant: "lines" })}
                  tabIndex={on ? 0 : -1}
                  onClick={() => selectView(entry)}
                >
                  {entry.kind === "runtime"
                    ? <ProviderIconStack runtimeProvider={entry.backend.kind === DEFAULT_RUNTIME ? "pi" : entry.backend.kind} className="rail-icon" hint={false} />
                    : entry.kind === "maker"
                      ? <ProviderIconStack modelProvider={entry.maker} className="rail-icon" hint={false} />
                      : entry.kind === "recent" ? <History size={16} className="rail-glyph recent" /> : <Star size={16} fill="currentColor" className="rail-glyph" />}
                  {entry.kind === "runtime" && entry.backend.kind.includes("@")
                    ? <i className="rail-instance" aria-hidden>{monogram(runtimeInstanceId(entry.backend.kind))}</i>
                    : null}
                  {entry.kind === "runtime" ? <i className={`runtime-dot runtime-dot-${entry.status}`} aria-hidden /> : null}
                </button>
              </div>
            );
          })}
        </nav>

        <section className="model-column" aria-label="Models">
          <header className="model-column-head">
            <span className="model-column-title">{heading}</span>
          </header>
          {elsewhere ? (
            <div className="model-runtime-pane" role="region" aria-label={elsewhere.backend.label}>
              <ProviderIconStack runtimeProvider={elsewhere.backend.kind} className="runtime-pane-icon" />
              <p>{unlistedReason(elsewhere.backend.label, catalogs.get(elsewhere.backend.kind)) ?? (elsewhere.backend.kind === threadRuntime
                ? `This thread starts on ${elsewhere.backend.label} with its default model. Its models are listed once the thread exists.`
                : draft
                  ? `${elsewhere.backend.label} can run this thread; its models are listed once a thread runs on it.`
                  : `This thread runs on ${threadRuntimeName}, and a thread keeps the runtime it started on. ${elsewhere.backend.label} runs a thread of its own.`)}</p>
              <div className="model-runtime-pane-actions">
                {elsewhereFix ? <button className="primary" onClick={elsewhereFix.run}>{elsewhereFix.label}</button> : null}
                {newThreadAction ? <button className={elsewhereFix ? "" : "primary"} onClick={newThreadAction.run}>{newThreadAction.label}</button> : null}
                {kitActions ? runtimeActions.map((action) => (
                  <button key={action.id} onClick={() => { action.run(kitActions.kind); onClose(); }}>{`${action.label} ${kitActions.label}`}</button>
                )) : null}
              </div>
            </div>
          ) : (
            <VirtualList
              id={listId}
              items={rows}
              itemHeight={compact ? touchRowHeight : rowHeight}
              className="model-list"
              role="listbox"
              ariaLabel={needle ? "Models of every provider" : `${viewLabel(current)} models`}
              scrollToIndex={at >= 0 ? at : undefined}
              empty={<p className="palette-empty">{needle
                ? `No model matches “${query}”.`
                : current.kind === "favourites" ? "Nothing pinned yet. Pin a model with its star to keep it here with its way to run it; ⌘1–9 reach the first nine."
                  : current.kind === "recent" ? "Models you choose show up here." : filterCount(filters) > 0 ? "No model passes the filters." : "No models."}</p>}
              renderItem={(row, index) => row.kind !== "entry"
                ? <div
                  key={row.key}
                  id={`model-option-${index}`}
                  role="option"
                  aria-selected={index === at}
                  aria-expanded={row.expanded}
                  aria-label={row.kind === "legacy" ? `Legacy models, ${row.count}` : row.expanded ? "Pinned only" : `Show all ${row.count}`}
                  className={`model-row model-fold ${index === at ? "selected" : ""}`}
                  onClick={() => toggleFold(row)}
                >
                  <span className="model-line">{row.kind === "legacy"
                    ? <>Legacy models <small>{row.count}</small></>
                    : row.expanded ? "Pinned only" : `Show all ${row.count}`}</span>
                  <span className="model-chevron">{row.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                </div>
                : <EntryRow
                  key={row.key}
                  id={`model-option-${index}`}
                  entry={row.entry}
                  way={wayOf(row)}
                  selected={index === at}
                  cells={cells}
                  onPoint={() => point(index)}
                  onLeave={() => clearTimeout(pointTimer.current)}
                  onChoose={(add) => {
                    clearTimeout(pointTimer.current);
                    setCursor(index);
                    choose(wayOf(row), add);
                  }}
                />}
            />
          )}
        </section>
      </div>

      {elsewhere ? null : waysBar}
      {multiSelect && chosen.length > 1 ? <p className="model-picker-note">{`${chosen.length} models chosen`}</p> : null}
      {staleNote ? <p className="model-picker-note" role="status">{staleNote}</p> : null}
      {notes.map((note) => <p key={note} className="model-picker-note">{note}</p>)}
      {update ? <p className="model-picker-note" role="status">{update.text}{update.command ? <> {update.verb} <code>{update.command}</code>.</> : null}</p> : null}
      {asSheet && onOpenThinking ? (
        <button type="button" className="model-thinking-row" onClick={onOpenThinking}>
          Thinking and speed<span>{thinkingSummary}<ChevronRight size={16} aria-hidden /></span>
        </button>
      ) : null}
    </div>
  );
  // Escape or a press outside closes an open menu first.
  const dismiss = () => {
    if (!menu) { onClose(); return; }
    setMenu(undefined);
    inputRef.current?.focus();
  };
  useSheetDrag(sheetRef, onClose);
  const addProvider = addProviderOpen ? (
    <Suspense fallback={null}>
      <LazyAddModelProviderModal
        onClose={() => setAddProviderOpen(false)}
        onProviderAdded={(newModels) => {
          setAddProviderOpen(false);
          const latest = newModels[newModels.length - 1];
          if (latest) setView(makerView(modelMaker(latest)));
        }}
      />
    </Suspense>
  ) : null;

  // Popover placed itself at the chip, in its own layout effect and resize listener; both run before these.
  const adding = addProvider !== null;
  useLayoutEffect(() => {
    const popover = surfaceRef.current?.closest<HTMLElement>(".popover");
    const frame = placeAgainst?.current;
    if (!popover || !frame) return undefined;
    const place = () => {
      const placed = placeFloating(frame.getBoundingClientRect(), popover.getBoundingClientRect(), viewportSize(), { side, align: "start" });
      popover.style.left = `${placed.left}px`;
      popover.style.top = `${placed.top}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [adding, placeAgainst, side]);

  // A press in the form would count as outside the popover, so the form takes the popover's place.
  return addProvider ?? (
    <Popover anchor={anchor} side={side} align="start" label="Select model" className={`model-picker${asSheet ? " model-picker-sheet" : ""}`} onClose={dismiss}>
      {content}
    </Popover>
  );
}
