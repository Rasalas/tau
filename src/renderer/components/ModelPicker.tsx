import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Plus, Search, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel, UiRuntimeBackend } from "../../shared/contracts";
import { SUBSCRIPTION_LOGIN_NOTE } from "../../shared/subscription-login";
import { modelPresentation, type ModelPresentation } from "../model-manifest";
import { usePreferences } from "../renderer-services-context";
import type { ModelSelectionContribution } from "../extension-system";
import { AddModelProviderModal } from "./AddModelProviderModal";
import { ProviderIconStack, providerLabel } from "./ProviderIconStack";
import { VirtualList } from "./VirtualList";

/** Sentinel for the pinned tab; never rendered verbatim. */
const FAVOURITES = "\u0000favourites";
const ROW_HEIGHT = 54;
/** ⌘1 to ⌘9 reach the first nine favourites, in the order they were starred. */
const JUMP_KEYS = 9;
const NO_SELECTION: readonly string[] = [];
const noSubscription = () => () => undefined;

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

interface Entry {
  key: string;
  model: UiModel;
  favourite: boolean;
  /** Position among the favourites, when one of the first nine. */
  jump?: number;
  presentation: ModelPresentation;
}

/** One line of the list: a model, or the fold that hides a provider's legacy models. */
type Row =
  | { kind: "model"; key: string; entry: Entry }
  | { kind: "legacy"; key: string; provider: string; count: number; expanded: boolean };

/** "added", or "×2" for a model chosen twice. */
function selectedLabel(chosen: readonly string[], key: string): string {
  const count = chosen.filter((entry) => entry === key).length;
  return count > 1 ? `×${count}` : "added";
}

function matches(entry: Entry, needle: string): boolean {
  if (!needle) return true;
  return `${entry.model.name} ${entry.model.provider} ${entry.model.id}`.toLowerCase().includes(needle);
}

export function ModelPicker({
  models,
  activeKey,
  onSelect,
  onClose,
  runtime,
  runtimeBackends,
  onSelectRuntime,
  modelsAvailable = true,
  multiSelect,
}: {
  models: readonly UiModel[];
  activeKey?: string;
  onSelect(model: UiModel): void;
  onClose(): void;
  /** The runtime the picked model runs on; its logo is paired with the provider's when they differ. */
  runtime?: string;
  /** Offered while choosing the runtime and model for a thread that does not exist yet. */
  runtimeBackends?: readonly UiRuntimeBackend[];
  onSelectRuntime?(kind: ThreadBackendKind): void;
  /** False when the visible catalog belongs to a different runtime. */
  modelsAvailable?: boolean;
  /** Shift-click builds a set of models here instead of picking one; a new thread's picker only. */
  multiSelect?: ModelSelectionContribution;
}) {
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const [expandedLegacy, setExpandedLegacy] = useState<ReadonlySet<string>>(() => new Set());
  const [addProviderOpen, setAddProviderOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const chosen = useSyncExternalStore(
    multiSelect?.subscribe ?? noSubscription,
    () => multiSelect?.selected() ?? NO_SELECTION,
    () => NO_SELECTION,
  );

  const entries = useMemo<Entry[]>(
    () => (modelsAvailable ? models : []).map((model) => {
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
    [models, modelsAvailable, settings.favouriteModels],
  );

  const providers = useMemo(() => {
    const names = [...new Set(entries.map((entry) => entry.model.provider))].sort();
    return entries.some((entry) => entry.favourite) ? [FAVOURITES, ...names] : names;
  }, [entries]);

  // Land on the active model's provider so the picker opens where you already are.
  useEffect(() => {
    setProvider((current) => {
      if (current && providers.includes(current)) return current;
      const active = entries.find((entry) => entry.key === activeKey);
      return active?.model.provider ?? providers[0];
    });
  }, [activeKey, entries, providers]);

  // A legacy model in use is not hidden from the person using it.
  useEffect(() => {
    const active = entries.find((entry) => entry.key === activeKey);
    if (!active?.presentation.legacy) return;
    setExpandedLegacy((current) => current.has(active.model.provider) ? current : new Set([...current, active.model.provider]));
  }, [activeKey, entries]);

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const needle = query.trim().toLowerCase();

  // A query searches every provider; without one, the side tab scopes the list.
  const rows = useMemo<Row[]>(() => {
    const filtered = entries.filter((entry) => matches(entry, needle));
    const asRows = (list: Entry[]): Row[] => list.map((entry) => ({ kind: "model", key: entry.key, entry }));
    if (needle) return asRows(filtered);
    if (provider === FAVOURITES) return asRows(filtered.filter((entry) => entry.favourite));
    const scoped = filtered.filter((entry) => entry.model.provider === provider);
    const current = scoped.filter((entry) => !entry.presentation.legacy);
    const legacy = scoped.filter((entry) => entry.presentation.legacy);
    if (legacy.length === 0 || !provider) return asRows(scoped);
    const expanded = expandedLegacy.has(provider);
    return [
      ...asRows(current),
      { kind: "legacy", key: `legacy:${provider}`, provider, count: legacy.length, expanded },
      ...(expanded ? asRows(legacy) : []),
    ];
  }, [entries, expandedLegacy, needle, provider]);

  useEffect(() => setCursor(0), [needle, provider]);

  const toggleLegacy = (name: string) => {
    setExpandedLegacy((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

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
    if (row.kind === "legacy") { toggleLegacy(row.provider); return; }
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
      if (providers.length > 1) {
        event.preventDefault();
        if (needle) setQuery("");
        setProvider((curr) => {
          const idx = curr ? providers.indexOf(curr) : 0;
          const delta = event.key === "ArrowRight" ? 1 : -1;
          const nextIdx = (idx + delta + providers.length) % providers.length;
          return providers[nextIdx];
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
      activate(rows[cursor], event.altKey, event.shiftKey);
    }
  };

  const tabCount = (name: string) => name === FAVOURITES
    ? entries.filter((entry) => entry.favourite).length
    : entries.filter((entry) => entry.model.provider === name).length;
  const tabLabel = (name: string) => name === FAVOURITES ? "Favourites" : providerLabel(name);

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section
        className={`model-picker ${(runtimeBackends?.length ?? 0) > 1 ? "with-runtime-picker" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label="Select model"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="model-picker-body">
          <nav className="model-rail" aria-label="Providers">
            {providers.map((name) => (
              <button
                key={name}
                className={!needle && name === provider ? "active" : ""}
                aria-label={`${tabLabel(name)} (${tabCount(name)})`}
                aria-pressed={!needle && name === provider}
                title={`${tabLabel(name)} · ${tabCount(name)}`}
                onClick={() => { setQuery(""); setProvider(name); }}
              >
                {name === FAVOURITES
                  ? <Star size={16} fill="currentColor" />
                  : <ProviderIconStack modelProvider={name} runtimeProvider={runtime} className="rail-icon" />}
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
                disabled={!modelsAvailable}
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

            {(runtimeBackends?.length ?? 0) > 1 ? (
              <div className="model-runtime-picker" role="group" aria-label="Runtime for new thread">
                <span>Run with</span>
                <div>
                  {runtimeBackends?.map((backend) => (
                    <button
                      key={backend.kind}
                      className={backend.kind === runtime ? "active" : ""}
                      aria-label={backend.label}
                      aria-pressed={backend.kind === runtime}
                      onClick={() => onSelectRuntime?.(backend.kind)}
                    >
                      <ProviderIconStack runtimeProvider={backend.kind} className="runtime-option-icon" />
                      {backend.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            <VirtualList
              items={rows}
              itemHeight={ROW_HEIGHT}
              className="model-list"
              scrollToIndex={cursor}
              empty={<p className="palette-empty">{!modelsAvailable
                ? `Start the thread to load ${runtimeBackends?.find((backend) => backend.kind === runtime)?.label ?? "this runtime"}'s models.`
                : needle ? `No model matches “${query}”.` : "No models from this provider."}</p>}
              renderItem={(row, index) => row.kind === "legacy"
                ? <div key={row.key} className={`model-row model-legacy ${index === cursor ? "selected" : ""}`} onMouseMove={() => setCursor(index)}>
                  <button className="model-choose" aria-expanded={row.expanded} onClick={() => toggleLegacy(row.provider)}>
                    <span className="model-line"><strong>Legacy models</strong></span>
                    <small className="model-sub">{row.count} {row.count === 1 ? "model" : "models"}</small>
                  </button>
                  <span className="model-chevron">{row.expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</span>
                </div>
                : <div
                  key={row.key}
                  data-provider={row.entry.model.provider}
                  className={`model-row ${index === cursor ? "selected" : ""} ${row.key === activeKey ? "current" : ""}`}
                  onMouseMove={() => setCursor(index)}
                >
                  <button className="model-choose" onClick={(event) => choose(row.entry, event.shiftKey)}>
                    <span className="model-line">
                      <strong>{row.entry.model.name}</strong>
                      {row.entry.presentation.badge === "new" ? <span className="model-badge model-badge-new">NEW</span> : null}
                      {needle && row.entry.presentation.legacy ? <span className="model-badge">legacy</span> : null}
                      {row.entry.model.login === "subscription" ? <span className="model-badge">subscription login</span> : null}
                    </span>
                    <small className="model-sub">
                      <ProviderIconStack modelProvider={row.entry.model.provider} runtimeProvider={runtime} className="sub-icon" />
                      {providerLabel(row.entry.model.provider)}
                      <span className="model-id">{row.entry.model.id}</span>
                    </small>
                  </button>
                  {row.key === activeKey && chosen.length === 0 ? <em>in use</em> : null}
                  {chosen.includes(row.key) ? <em className="model-chosen">{selectedLabel(chosen, row.key)}</em> : null}
                  {row.entry.jump ? <kbd className="model-kbd">⌘{row.entry.jump}</kbd> : null}
                  <button className={`model-star ${row.entry.favourite ? "on" : ""}`} aria-label={row.entry.favourite ? `Unfavourite ${row.entry.model.name}` : `Favourite ${row.entry.model.name}`} aria-pressed={row.entry.favourite} onClick={() => preferences.toggleFavouriteModel(row.key)}><Star size={14} fill={row.entry.favourite ? "currentColor" : "none"} /></button>
                </div>}
            />
          </div>
        </div>

        {rows.some((row) => row.kind === "model" && row.entry.model.login === "subscription") ? <p className="model-picker-note">{SUBSCRIPTION_LOGIN_NOTE}</p> : null}

        <footer>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>⌥↵ favourite</span>
          <span>⌘1–9 favourite n</span>
          {multiSelect ? <span>{chosen.length > 1 ? `${chosen.length} models chosen` : "⇧click add a model"}</span> : null}
          <span className="spacer" />
          <span>{entries.length} models · {providers.filter((name) => name !== FAVOURITES).length} providers</span>
        </footer>
      </section>
      {addProviderOpen ? (
        <AddModelProviderModal
          onClose={() => setAddProviderOpen(false)}
          onProviderAdded={(newModels) => {
            setAddProviderOpen(false);
            const latest = newModels[newModels.length - 1];
            if (latest) setProvider(latest.provider);
          }}
        />
      ) : null}
    </div>
  );
}
