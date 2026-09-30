import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { Check, ChevronDown, ChevronUp, Layers, Search, SlidersHorizontal, Star, X } from "lucide-react";
import type { ThreadBackendKind, UiModel, UiRuntimeBackend } from "../../shared/contracts";
import type { ModelBadgeContribution, ModelSelectionContribution } from "../extension-system";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { withPriceOverride } from "../../shared/model-prices";
import { modelPresentation } from "../model-manifest";
import { getHostClient } from "../host-client-context";
import { usePreferences } from "../renderer-services-context";
import { DEFAULT_RUNTIME } from "../runtime-marks";
import { runtimeInstanceId } from "../../shared/runtime-instances";
import { runtimeUpdate } from "../runtime-update";
import { DEFAULT_THINKING, THINKING_LABELS } from "../thinking-levels";
import {
  RUNTIME_STATUS_LABELS, pickerViews, runtimeView, type RuntimeStatus, type ViewEntry,
} from "./model-picker-rail";
import {
  NO_FILTERS, filterCount, modelKey, offeringKey, orderedPositions, passesFilters, searchOfferings, sortOfferings,
  type BillingFilter, type CapabilityFilter, type Offering, type OfferingFilters, type OfferingSort,
} from "./model-offerings";
import { OfferingMarks, OfferingRow, modelFacts, wears, type RowCell } from "./ModelPickerRow";
import { ProviderIconStack, monogram, providerLabel } from "./ProviderIconStack";
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
/** Below these widths the three columns stack: runtimes above the models, thinking below them. */
const STACK_WIDTH = 640;
const SHEET_STACK_WIDTH = 700;
/** A runtime with more models than this and none pinned still folds behind "Show all". */
const FOLD_UNPINNED = 8;
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

/** The reasoning level of the model in use, the picker's third column. */
export interface ThinkingChoice {
  level?: string;
  /** The levels the model in use offers. */
  levels: readonly string[];
  /** Absent where nothing can set it; `note` says why. */
  onSelect?(level: string): void;
  note?: string;
}

/** One line of the list. */
type Row =
  | { kind: "offering"; key: string; offering: Offering; grouped: boolean; cross: boolean }
  | { kind: "group"; key: string; name: string; count: number }
  | { kind: "legacy"; key: string; count: number; expanded: boolean }
  | { kind: "more"; key: string; count: number; expanded: boolean };

const rowHeight = (row: Row): number => row.kind === "group" ? 24 : row.kind === "offering" ? (row.grouped ? 30 : 34) : 30;
/** On a phone every row that can be tapped is at least a finger (44 px) high. */
const touchRowHeight = (row: Row): number => row.kind === "group" ? 28 : row.kind === "offering" ? 48 : 44;
const selectable = (row: Row | undefined): boolean => row !== undefined && row.kind !== "group";

const SORT_LABELS: Record<OfferingSort, string> = { relevance: "Relevance", price: "Price", context: "Context", newest: "Newest" };
const BILLING_FILTERS: ReadonlyArray<[BillingFilter, string]> = [["subscription", "Plan"], ["api", "API key"], ["free", "Free or local"]];
const CAPABILITY_FILTERS: ReadonlyArray<[CapabilityFilter, string]> = [["images", "Reads images"], ["reasoning", "Reasoning"]];
/** A runtime in one of these states cannot run a thread yet: dimmed, with the reason and a way to fix it. */
const BLOCKED: ReadonlySet<RuntimeStatus> = new Set(["not-installed", "sign-in", "unavailable"]);

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

function thinkingLabel(level: string): string {
  return THINKING_LABELS[level] ?? (level ? level[0]!.toUpperCase() + level.slice(1) : level);
}

function countLabel(count: number): string {
  return `${count} ${count === 1 ? "model" : "models"}`;
}

/** A provider's mark among a runtime's providers, or one for all of them. */
function ProviderChoiceMark({ provider }: { provider: string | undefined }) {
  return provider
    ? <ProviderIconStack modelProvider={provider} className="provider-column-icon" hint={false} />
    : <Layers size={15} className="provider-all-glyph" aria-hidden />;
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
  const button = column?.querySelector<HTMLButtonElement>("button[data-column-item][data-current]") ?? column?.querySelector<HTMLButtonElement>("button[data-column-item]");
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
  thinking,
  onOpenSettings: openSettings,
  focus,
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
  /** Every runtime the host offers; each is an entry of the left column. */
  runtimeBackends?: readonly UiRuntimeBackend[];
  /** The host's catalogs of every runtime, so another runtime lists its models too. */
  catalogs?: ReadonlyMap<ThreadBackendKind, RuntimeCatalogEntry>;
  /** Set while the thread does not exist yet: its runtime can still change, and a click on one changes it. */
  onSelectRuntime?(kind: ThreadBackendKind): void;
  /** For a thread that exists: another runtime means another thread, which starts on `model` when one was chosen. */
  onNewThreadOnRuntime?(kind: ThreadBackendKind, model?: UiModel): void;
  /** For a thread that exists: what else can be done with another runtime (`runtime-switch` commands). */
  runtimeActions?: readonly RuntimeAction[];
  /** Marks extensions put on model rows (`registerModelBadge`). */
  badges?: readonly ModelBadgeContribution[];
  /** Shift-click builds a set of models here instead of picking one; a new thread's picker only. */
  multiSelect?: ModelSelectionContribution;
  /** The third column; without it the picker has none. */
  thinking?: ThinkingChoice;
  /**
   * Settings for a runtime: its card, to install or sign in ("runtime"), or its models, to pin them ("models").
   * By default the workbench's own Settings: the runtime's card under Providers, and its models there.
   */
  onOpenSettings?(kind: ThreadBackendKind, part: "runtime" | "models"): void;
  /** "thinking": opens with the focus on the thinking column, as the composer's reasoning level asks. */
  focus?: "thinking";
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
  const [view, setView] = useState(() => runtimeView(threadRuntime));
  const [providers, setProviders] = useState<Record<string, string | undefined>>({});
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
  // The model chosen in this opening, until the thread reports it in use.
  const [chosenKey, setChosenKey] = useState<string>();
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const stacked = useStacked(asSheet);
  const sheetRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => { sheetRef.current = asSheet ? surfaceRef.current?.closest<HTMLElement>(".model-picker") ?? null : null; }, [asSheet]);
  const runtimeColumnRef = useRef<HTMLElement>(null);
  const thinkingColumnRef = useRef<HTMLDivElement>(null);
  const thinkingFocus = useRef(focus === "thinking");
  const chosen = useSyncExternalStore(
    multiSelect?.subscribe ?? noSubscription,
    () => multiSelect?.selected() ?? NO_SELECTION,
    () => NO_SELECTION,
  );

  const views = useMemo(() => pickerViews({ catalogRuntime: onHand, backends: runtimeBackends, catalogs, recent: false }), [catalogs, onHand, runtimeBackends]);
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
  /** The model last chosen on `kind`, which its list preselects when the thread is elsewhere. */
  const recentOf = useCallback((kind: ThreadBackendKind) => settings.recentModels.find((key) => byKey.get(key)?.runtime === kind), [byKey, settings.recentModels]);

  const current = views.find((entry) => entry.key === view) ?? views.find((entry) => entry.kind === "runtime");
  const currentRuntime = current?.kind === "runtime" ? current : undefined;
  const runtimeOfferings = useMemo(() => currentRuntime ? offerings.filter((offering) => offering.runtime === currentRuntime.backend.kind) : [], [currentRuntime, offerings]);
  const providerCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const offering of runtimeOfferings) if (!offering.hidden || showHidden) counts.set(offering.model.provider, (counts.get(offering.model.provider) ?? 0) + 1);
    return [...counts].sort(([a], [b]) => providerLabel(a).localeCompare(providerLabel(b)));
  }, [runtimeOfferings, showHidden]);
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
    const group = `${current.key}/${provider ?? ""}`;
    // The legacy fold is the runtime's own order's; a sort or filter lists everything.
    const withLegacy = (list: readonly Offering[]): Row[] => {
      const latest = list.filter((offering) => !offering.legacy);
      const legacy = list.filter((offering) => offering.legacy);
      if (legacy.length === 0 || sort !== "relevance" || filterCount(filters) > 0) return list.map((offering) => offeringRow(offering));
      const expanded = expandedLegacy.has(group) || legacy.some((offering) => offering.key === activeOffering);
      return [
        ...latest.map((offering) => offeringRow(offering)),
        { kind: "legacy", key: `legacy:${group}`, count: legacy.length, expanded },
        ...(expanded ? legacy.map((offering) => offeringRow(offering)) : []),
      ];
    };
    if (provider || sort !== "relevance" || filterCount(filters) > 0) return withLegacy(scoped);
    // Pinned first: the favourites, the model in use and the one last chosen here; the rest behind "Show all".
    const keep = new Set([activeOffering, recentOf(current.backend.kind)]);
    const pinned = scoped.filter((offering) => offering.favourite || keep.has(offering.key));
    const rest = scoped.filter((offering) => !pinned.includes(offering));
    const folds = pinned.length > 0 && rest.length > 0 && (pinned.some((offering) => offering.favourite) || scoped.length > FOLD_UNPINNED);
    if (!folds) return withLegacy(scoped);
    const open = expandedAll.has(group);
    return [
      ...pinned.map((offering) => offeringRow(offering)),
      { kind: "more", key: `more:${group}`, count: scoped.length, expanded: open },
      ...(open ? withLegacy(rest) : []),
    ];
  }, [activeOffering, byKey, current, expandedAll, expandedLegacy, filters, needle, offerings, provider, recentOf, runtimeOfferings, settings.favouriteModels, settings.recentModels, shown, sort, threadRuntime]);

  // The cursor starts on the model in use, else on the one last chosen on this runtime, else on the first row.
  const initialCursor = useMemo(() => {
    const plain = !needle && sort === "relevance" && filterCount(filters) === 0;
    const preferred = [activeOffering, currentRuntime ? recentOf(currentRuntime.backend.kind) : undefined];
    for (const key of plain ? preferred : []) {
      const index = key ? rows.findIndex((row) => row.kind === "offering" && row.key === key) : -1;
      if (index >= 0) return index;
    }
    return rows.findIndex(selectable);
  }, [activeOffering, currentRuntime, filters, needle, recentOf, rows, sort]);
  useEffect(() => setCursor(undefined), [needle, view, provider, sort, filters]);
  const at = cursor !== undefined && selectable(rows[cursor]) ? cursor : initialCursor;

  // Again after the add-provider form, which a popover picker gives its place to.
  useEffect(() => {
    // Opened for its thinking column, the picker keeps the focus there.
    if (!addProviderOpen) requestAnimationFrame(() => { if (!thinkingColumnRef.current?.contains(document.activeElement)) inputRef.current?.focus(); });
  }, [addProviderOpen]);
  useFocusTrap(surfaceRef, !addProviderOpen);

  const notes = useMemo(() => {
    const listed = rows.flatMap((row) => row.kind === "offering" ? [row.offering] : []);
    return [...new Set(badges.filter((badge) => badge.note && listed.some((offering) => wears(badge, offering.model, offering.runtime))).map((badge) => badge.note as string))];
  }, [badges, rows]);

  // Thinking belongs to the model in use, or to the one just chosen until the thread reports it.
  const inUse = activeOffering ? byKey.get(activeOffering) : undefined;
  const pending = chosenKey && chosenKey !== activeOffering ? byKey.get(chosenKey) : undefined;
  const thinkingModel = pending?.model ?? inUse?.model ?? (activeKey ? models.find((model) => modelKey(model) === activeKey) : undefined);
  // A chosen model whose levels only the thread knows shows none until it reports them.
  const levels = pending ? pending.levels : thinking?.levels ?? [];
  const canThink = thinking?.onSelect !== undefined && levels.length > 1;
  const level = thinking?.level && levels.includes(thinking.level) ? thinking.level : undefined;
  // A choice keeps the picker open only while a level is still to choose for it.
  const offersLevels = (offering: Offering): boolean => {
    if (!thinking?.onSelect || offering.runtime !== onHand || offering.runtime !== threadRuntime) return false;
    if (offering.levels.length > 0) return offering.levels.length > 1;
    return offering.model.reasoning ?? thinking.levels.length > 1;
  };
  // After a choice the focus goes to the levels, once there are some; new levels replace the buttons it sat on.
  useEffect(() => {
    if (chosenKey) thinkingFocus.current = true;
  }, [chosenKey]);
  useEffect(() => {
    if (!thinkingFocus.current) return;
    const column = thinkingColumnRef.current;
    if (column?.contains(document.activeElement)) return;
    if (focusColumn(column)) thinkingFocus.current = false;
  }, [chosenKey, levels]);

  const threadRuntimeName = runtimeName(threadRuntime, runtimeBackends);
  const update = !needle && currentRuntime ? runtimeUpdate(currentRuntime.backend) : undefined;
  // A runtime whose models are not on hand: say what choosing it means.
  const elsewhere = !needle && currentRuntime && !currentRuntime.listed ? currentRuntime : undefined;
  const blocked = elsewhere && BLOCKED.has(elsewhere.status) ? elsewhere : undefined;
  // Another runtime's models, for a thread that exists: picking one starts a thread there.
  const foreign = !draft && !needle && currentRuntime && currentRuntime.listed && currentRuntime.backend.kind !== threadRuntime ? currentRuntime.backend : undefined;
  const foreignEntry = currentRuntime && currentRuntime.backend.kind !== threadRuntime ? catalogs.get(currentRuntime.backend.kind) : undefined;
  const staleNote = !needle && foreignEntry?.status === "ready" && foreignEntry.catalog.status ? foreignEntry.catalog.note : undefined;
  const newThreadAction = !draft && onNewThreadOnRuntime && currentRuntime && currentRuntime.backend.kind !== threadRuntime && !blocked
    ? { label: `New thread on ${currentRuntime.backend.label}`, run: () => { onNewThreadOnRuntime(currentRuntime.backend.kind); onClose(); } }
    : undefined;
  const fixAction = blocked && onOpenSettings
    ? {
      label: blocked.status === "not-installed" ? `Install ${blocked.backend.label}…` : blocked.status === "sign-in" ? `Sign in to ${blocked.backend.label}…` : `${blocked.backend.label} settings`,
      run: () => { onOpenSettings(blocked.backend.kind, "runtime"); onClose(); },
    }
    : undefined;
  const kitActions = !draft && currentRuntime && currentRuntime.backend.kind !== threadRuntime && !needle && !blocked ? currentRuntime.backend : undefined;

  const choose = (offering: Offering, add = false) => {
    if (multiSelect && add) {
      multiSelect.toggle(offering.model, models.find((model) => modelKey(model) === activeKey), offering.runtime, onHand);
      return;
    }
    if (offering.runtime !== onHand) {
      multiSelect?.reset();
      preferences.noteModelUsed(offering.key);
      onSelect(offering.model, offering.runtime);
      onClose();
      return;
    }
    multiSelect?.reset();
    preferences.noteModelUsed(offering.key);
    const stays = offersLevels(offering);
    onSelect(offering.model);
    if (stays) setChosenKey(offering.key);
    else onClose();
  };
  const chooseLevel = (next: string) => {
    thinking?.onSelect?.(next);
    onClose();
  };
  const toggleFold = (row: Extract<Row, { kind: "legacy" | "more" }>) => {
    if (row.kind === "legacy") setExpandedLegacy((held) => toggled(held, row.key.replace(/^legacy:/u, "")));
    else setExpandedAll((held) => toggled(held, row.key.replace(/^more:/u, "")));
  };
  const activate = (row: Row | undefined, alt: boolean, add = false) => {
    if (!row || row.kind === "group") return;
    if (row.kind === "legacy" || row.kind === "more") { toggleFold(row); return; }
    if (alt) preferences.toggleFavouriteModel(row.key);
    else choose(row.offering, add);
  };
  const selectView = (entry: ViewEntry) => {
    setQuery("");
    setMenu(undefined);
    setView(entry.key);
    // One click is the choice: a draft moves to a runtime that can run it, with what it last chose there.
    if (draft && entry.kind === "runtime" && entry.backend.kind !== threadRuntime && !BLOCKED.has(entry.status) && entry.status !== "loading") {
      onSelectRuntime?.(entry.backend.kind);
    }
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
    // ⌘⇧↑/↓: the next entry of the left column, from anywhere in the picker.
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      const index = Math.max(0, views.findIndex((entry) => entry.key === current?.key));
      const next = views[(index + (event.key === "ArrowDown" ? 1 : -1) + views.length) % views.length];
      if (next) selectView(next);
    }
  };

  const onSearchKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const collapsed = input.selectionEnd === input.selectionStart;
    const plain = !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (event.key === "ArrowLeft" && plain && collapsed && (input.selectionStart ?? 0) === 0) {
      if (focusColumn(runtimeColumnRef.current)) event.preventDefault();
      return;
    }
    if (event.key === "ArrowRight" && plain && collapsed && (input.selectionStart ?? 0) === input.value.length) {
      if (focusColumn(thinkingColumnRef.current)) event.preventDefault();
      return;
    }
    if (event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowDown") { event.preventDefault(); stepCursor(1); }
    if (event.key === "ArrowUp") { event.preventDefault(); stepCursor(-1); }
    if (event.key === "Enter") {
      event.preventDefault();
      if (rows.length) activate(rows[at], event.altKey, event.shiftKey);
      else (fixAction ?? newThreadAction)?.run();
    }
  };

  const onColumnKeyDown = (column: "runtimes" | "thinking") => (event: KeyboardEvent) => {
    const typed = typedCharacter(event);
    if (typed) {
      event.preventDefault();
      setQuery((held) => held + typed);
      inputRef.current?.focus();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const own = column === "runtimes" ? runtimeColumnRef.current : thinkingColumnRef.current;
    const back = column === "runtimes" ? "ArrowRight" : "ArrowLeft";
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = stepColumn(own, event.key === "ArrowDown" ? 1 : -1);
      // A runtime is shown as the arrow reaches it; a level waits for Enter.
      if (column === "runtimes") next?.click();
    } else if (event.key === back) {
      event.preventDefault();
      inputRef.current?.focus();
    } else if (event.key === "Enter" && column === "runtimes") {
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
  // The rail shows marks only; the tooltip names the entry and says its state.
  const viewTitle = (entry: ViewEntry): string => {
    if (entry.kind !== "runtime") return entry.kind === "favourites" ? "Favourites · pinned models of every runtime" : viewLabel(entry);
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
  const cells: RowCell = {
    badges,
    inUse: (key) => key === activeOffering && chosen.length === 0,
    chosen: (key) => {
      const offering = offerings.find((entry) => entry.key === key);
      const selected = offering ? `${offering.runtime}::${modelKey(offering.model)}` : key;
      const legacy = offering ? modelKey(offering.model) : key;
      return chosen.includes(selected) ? selectedLabel(chosen, selected) : chosen.includes(legacy) ? selectedLabel(chosen, legacy) : undefined;
    },
    jump: (key) => jumps.get(key),
    onFavourite: (offering) => preferences.toggleFavouriteModel(offering.key),
    onHide: (offering) => preferences.toggleHiddenModel(offering.runtime, modelKey(offering.model)),
    showLegacy: Boolean(needle),
    showProvider: !provider && providerCounts.length > 1,
  };
  const listId = "model-picker-list";
  const activeRow = rows[at];
  const detail = activeRow?.kind === "offering" ? activeRow.offering : undefined;

  const providerChoices = currentRuntime && providerCounts.length > 1 && !needle ? [
    { key: undefined, label: "All providers", count: providerCounts.reduce((sum, [, count]) => sum + count, 0) },
    ...providerCounts.map(([name, count]) => ({ key: name, label: providerLabel(name), count })),
  ] : [];
  const chooseProvider = (key: string | undefined) => {
    if (!currentRuntime) return;
    setQuery("");
    setProviders((held) => ({ ...held, [currentRuntime.backend.kind]: key }));
  };
  const recents = settings.recentModels.flatMap((key) => {
    const offering = key === activeOffering ? undefined : byKey.get(key);
    return offering ? [offering] : [];
  }).slice(0, stacked ? 6 : 3);
  const pinRuntime = currentRuntime?.backend.kind ?? threadRuntime;
  const optionsOn = filterCount(filters) + (sort === "relevance" ? 0 : 1) + (showHidden ? 1 : 0);
  const heading = needle ? "Every runtime" : current ? viewLabel(current) : "Models";

  const content: ReactNode = (
    <div
      ref={surfaceRef}
      className={`model-picker-content${stacked ? " stacked" : ""}`}
      data-keybinding-context="modelPicker"
      onKeyDown={onKeyDown}
    >
      {asSheet ? <header className="touch-sheet-header">
        <span className="touch-sheet-grip" aria-hidden="true" />
        <strong>Select model</strong>
        <button type="button" className="touch-icon-button" aria-label="Close" onClick={onClose}><X size={18} /></button>
      </header> : null}
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
          placeholder="Type to search all models…"
          aria-label="Search models"
        />
        {stacked ? null : <span className="model-keys keyboard-hint" aria-hidden {...tooltipProps(`↑↓ move · ←→ columns · ↵ choose · ⌥↵ pin${multiSelect ? " · ⇧click adds a model" : ""}`, { side: "bottom" })}>↑↓ ←→ ↵</span>}
        <div className="model-tool">
          <button
            className={`model-tool-button${optionsOn > 0 ? " on" : ""}`}
            aria-label={optionsOn > 0 ? `Sort and filter (${optionsOn} on)` : "Sort and filter"}
            {...tooltipProps("Sort, filter, hidden models, add a provider", { side: "bottom" })}
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
                Show hidden models{hiddenCount > 0 ? <small>{hiddenCount}</small> : null}
              </button>
              <button role="menuitem" onClick={() => { setMenu(undefined); setAddProviderOpen(true); }}>Add model provider…</button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="model-picker-body">
        <nav ref={runtimeColumnRef} className="model-rail" aria-label="Runtimes" onKeyDown={onColumnKeyDown("runtimes")}>
          {views.map((entry, index) => {
            const on = !needle && entry.key === current?.key;
            return (
              <div key={entry.key} className="model-rail-slot">
                {index === 1 ? <hr aria-hidden /> : null}
                <button
                  data-column-item
                  {...(on ? { "data-current": "" } : {})}
                  className={`${on ? "active" : ""}${entry.kind === "runtime" && BLOCKED.has(entry.status) ? " blocked" : ""}`}
                  aria-label={entry.kind === "runtime" ? `${entry.backend.label}, ${RUNTIME_STATUS_LABELS[entry.status]}` : viewLabel(entry)}
                  aria-pressed={on}
                  {...tooltipProps(viewTitle(entry), { side: stacked ? "bottom" : "left", variant: "lines" })}
                  tabIndex={on ? 0 : -1}
                  onClick={() => selectView(entry)}
                >
                  {entry.kind === "runtime"
                    ? <ProviderIconStack runtimeProvider={entry.backend.kind === DEFAULT_RUNTIME ? "pi" : entry.backend.kind} className="rail-icon" hint={false} />
                    : <Star size={16} fill="currentColor" className="rail-glyph" />}
                  {entry.kind === "runtime" && entry.backend.kind.includes("@")
                    ? <i className="rail-instance" aria-hidden>{monogram(runtimeInstanceId(entry.backend.kind))}</i>
                    : null}
                  {/* Ready is the usual state; only another one earns a dot. */}
                  {entry.kind === "runtime" && entry.status !== "ready" ? <i className={`runtime-dot runtime-dot-${entry.status}`} aria-hidden /> : null}
                </button>
              </div>
            );
          })}
        </nav>

        <section className="model-column" aria-label="Models">
          <header className="model-column-head">
            <span className="model-column-title">{heading}</span>
            {providerChoices.length ? (
              <span className="model-provider-filter" role="group" aria-label={`${currentRuntime!.backend.label} providers`}>
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
              </span>
            ) : null}
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
                {fixAction ? <button className="primary" onClick={fixAction.run}>{fixAction.label}</button> : null}
                {newThreadAction ? <button className={fixAction ? "" : "primary"} onClick={newThreadAction.run}>{newThreadAction.label}</button> : null}
                {kitActions ? runtimeActions.map((action) => (
                  <button key={action.id} onClick={() => { action.run(kitActions.kind); onClose(); }}>{`${action.label} ${kitActions.label}`}</button>
                )) : null}
              </div>
            </div>
          ) : <>
            <VirtualList
              id={listId}
              items={rows}
              itemHeight={compact ? touchRowHeight : rowHeight}
              className="model-list"
              role="listbox"
              ariaLabel={needle ? "Models in every runtime" : current ? `${viewLabel(current)} models` : "Models"}
              scrollToIndex={at >= 0 ? at : undefined}
              empty={<p className="palette-empty">{needle
                ? `No model matches “${query}”.`
                : current?.kind === "favourites" ? "Nothing pinned yet. Pin a model with its star to keep it first; ⌘1–9 reach the first nine."
                  : filterCount(filters) > 0 ? "No model passes the filters." : "No models."}</p>}
              renderItem={(row, index) => row.kind === "group"
                ? <div key={row.key} className="model-group" role="presentation"><span>{row.name}</span><small>{row.count}</small></div>
                : row.kind === "legacy" || row.kind === "more"
                  ? <div
                    key={row.key}
                    id={`model-option-${index}`}
                    role="option"
                    aria-selected={index === at}
                    aria-expanded={row.expanded}
                    aria-label={row.kind === "legacy" ? `Legacy models, ${row.count}` : row.expanded ? "Pinned only" : `Show all ${row.count}`}
                    className={`model-row model-fold ${index === at ? "selected" : ""}`}
                    onMouseMove={() => setCursor(index)}
                    onClick={() => toggleFold(row)}
                  >
                    <span className="model-line">{row.kind === "legacy"
                      ? <>Legacy models <small>{row.count}</small></>
                      : row.expanded ? "Pinned only" : `Show all ${row.count}`}</span>
                    <span className="model-chevron">{row.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
                  </div>
                  : <OfferingRow
                    key={row.key}
                    id={`model-option-${index}`}
                    offering={row.offering}
                    grouped={row.grouped}
                    cross={row.cross}
                    selected={index === at}
                    cells={cells}
                    onPoint={() => setCursor(index)}
                    onChoose={(add) => choose(row.offering, add)}
                  />}
            />
            <footer className="model-detail" aria-live="polite">
              {detail ? <>
                <span className="model-id">{detail.model.id}</span>
                {modelFacts(detail.model, detail.customPrice).map((fact) => <span key={fact}>{fact}</span>)}
              </> : null}
              {multiSelect && chosen.length > 1 ? <span className="model-detail-end">{`${chosen.length} models chosen`}</span> : null}
            </footer>
          </>}
        </section>

        {thinking ? (
          <section className="model-thinking" aria-label="Thinking">
            <header className="model-column-head">
              <span className="model-column-title">Thinking</span>
              {thinkingModel && canThink ? <small>{thinkingModel.name}</small> : null}
            </header>
            {canThink ? (
              <div ref={thinkingColumnRef} className="model-levels" role="radiogroup" aria-label={`Thinking for ${thinkingModel?.name ?? "the model"}`} onKeyDown={onColumnKeyDown("thinking")}>
                {levels.map((option) => (
                  <button
                    key={option}
                    role="radio"
                    aria-checked={option === level}
                    data-column-item
                    {...(option === level ? { "data-current": "" } : {})}
                    tabIndex={option === (level ?? levels[0]) ? 0 : -1}
                    className={option === level ? "active" : ""}
                    onClick={() => chooseLevel(option)}
                  >
                    <span className="model-level-name">{thinkingLabel(option)}</span>
                    {option === DEFAULT_THINKING && threadRuntime === DEFAULT_RUNTIME ? <small>default</small> : null}
                    {option === level ? <Check size={13} className="model-level-check" aria-hidden /> : null}
                  </button>
                ))}
              </div>
            ) : pending && levels.length === 0 ? null : (
              <p className="model-thinking-note">{thinking.note ?? (!thinking.onSelect
                ? threadRuntime !== onHand ? `${threadRuntimeName} sets thinking once this thread exists.` : "This runtime sets thinking itself."
                : thinkingModel ? `${thinkingModel.name} has no thinking levels.` : "Choose a model first.")}</p>
            )}
          </section>
        ) : null}
      </div>

      {foreign ? (
        <p className="model-picker-note">
          {`Choosing one starts a new thread on ${foreign.label}; this one stays on ${threadRuntimeName}.`}
          {newThreadAction ? <button className="model-note-action" onClick={newThreadAction.run}>{newThreadAction.label}</button> : null}
          {kitActions ? runtimeActions.map((action) => (
            <button key={action.id} className="model-note-action" onClick={() => { action.run(kitActions.kind); onClose(); }}>{`${action.label} ${kitActions.label}`}</button>
          )) : null}
        </p>
      ) : null}
      {staleNote ? <p className="model-picker-note" role="status">{staleNote}</p> : null}
      {notes.map((note) => <p key={note} className="model-picker-note">{note}</p>)}
      {update ? <p className="model-picker-note" role="status">{update.text}{update.command ? <> {update.verb} <code>{update.command}</code>.</> : null}</p> : null}

      {recents.length || onOpenSettings || refreshModels ? <footer className="model-recent">
        {recents.length ? <span className="model-recent-label">Recent</span> : null}
        {recents.length ? <span className="model-recent-list">
          {recents.map((offering) => (
            <button key={offering.key} className="model-recent-chip" aria-label={`${offering.model.name}, ${offering.runtimeLabel}`} onClick={() => choose(offering)}>
              <OfferingMarks offering={offering} />
              <span>{offering.model.name}</span>
            </button>
          ))}
        </span> : null}
        <span className="spacer" />
        {refreshModels ? (
          <button className="model-footer-link" disabled={refreshing} {...tooltipProps("Ask every runtime for its version and models again", { side: "top" })} onClick={() => {
            setRefreshing(true);
            void refreshModels("refresh").catch(() => undefined).finally(() => setRefreshing(false));
          }}>{refreshing ? "Refreshing…" : "Refresh"}</button>
        ) : null}
        {onOpenSettings ? (
          <button className="model-footer-link" onClick={() => { onOpenSettings(pinRuntime, "models"); onClose(); }}>
            {stacked ? "Pin in Settings" : "Pin models in Settings"}
          </button>
        ) : null}
      </footer> : null}
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
          if (latest) {
            setView(runtimeView(onHand));
            setProviders((held) => ({ ...held, [onHand]: latest.provider }));
          }
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
    <Popover anchor={anchor} side={side} align="start" label="Select model" className={`model-picker${asSheet ? " model-picker-sheet" : ""}${thinking ? " with-thinking" : ""}`} onClose={dismiss}>
      {content}
    </Popover>
  );
}
