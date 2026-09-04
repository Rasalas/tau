import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Search, Star } from "lucide-react";
import type { UiModel } from "../../shared/contracts";
import { usePreferences } from "../renderer-services-context";
import { VirtualList } from "./VirtualList";

/** Sentinel for the pinned tab; never rendered verbatim. */
const FAVOURITES = "\u0000favourites";

export function modelKey(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`;
}

interface Entry {
  key: string;
  model: UiModel;
  favourite: boolean;
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
}: {
  models: readonly UiModel[];
  activeKey?: string;
  onSelect(model: UiModel): void;
  onClose(): void;
}) {
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const [query, setQuery] = useState("");
  const [provider, setProvider] = useState<string>();
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo<Entry[]>(
    () => models.map((model) => {
      const key = modelKey(model);
      return { key, model, favourite: settings.favouriteModels.includes(key) };
    }),
    [models, settings.favouriteModels],
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

  useEffect(() => {
    requestAnimationFrame(() => inputRef.current?.focus());
  }, []);

  const needle = query.trim().toLowerCase();

  // A query searches every provider; without one, the side tab scopes the list.
  const visible = useMemo(() => {
    const filtered = entries.filter((entry) => matches(entry, needle));
    if (needle) return filtered;
    if (provider === FAVOURITES) return filtered.filter((entry) => entry.favourite);
    return filtered.filter((entry) => entry.model.provider === provider);
  }, [entries, needle, provider]);

  const grouped = useMemo(() => {
    const byProvider = new Map<string, Entry[]>();
    for (const entry of visible) {
      const existing = byProvider.get(entry.model.provider);
      if (existing) existing.push(entry);
      else byProvider.set(entry.model.provider, [entry]);
    }
    return [...byProvider.entries()];
  }, [visible]);
  const ordered = useMemo(() => grouped.flatMap(([, list]) => list), [grouped]);

  useEffect(() => setCursor(0), [needle, provider]);


  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "Escape") { onClose(); return; }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setCursor((value) => (ordered.length ? (value + 1) % ordered.length : 0));
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setCursor((value) => (ordered.length ? (value - 1 + ordered.length) % ordered.length : 0));
    }
    if (event.key === "Enter" && ordered[cursor]) {
      event.preventDefault();
      if (event.altKey) preferences.toggleFavouriteModel(ordered[cursor].key);
      else { onSelect(ordered[cursor].model); onClose(); }
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <section
        className="model-picker"
        role="dialog"
        aria-modal="true"
        aria-label="Select model"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="palette-input-wrap">
          <Search size={15} />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search models…"
            aria-label="Search models"
          />
          <kbd>esc</kbd>
        </div>

        <div className="model-picker-body">
          <nav className="model-providers" aria-label="Providers">
            {providers.map((name) => (
              <button
                key={name}
                className={!needle && name === provider ? "active" : ""}
                onClick={() => { setQuery(""); setProvider(name); }}
              >
                <span>{name === FAVOURITES ? "Favourites" : name}</span>
                <small>
                  {name === FAVOURITES
                    ? entries.filter((entry) => entry.favourite).length
                    : entries.filter((entry) => entry.model.provider === name).length}
                </small>
              </button>
            ))}
          </nav>

          <VirtualList
            items={ordered}
            itemHeight={47}
            className="model-list"
            scrollToIndex={cursor}
            empty={<p className="palette-empty">{needle ? `No model matches “${query}”.` : "No models from this provider."}</p>}
            renderItem={(entry, index) => <div
              key={entry.key}
              data-provider={entry.model.provider}
              className={`model-row ${index === cursor ? "selected" : ""} ${entry.key === activeKey ? "current" : ""}`}
              onMouseMove={() => setCursor(index)}
            >
              <button className="model-choose" onClick={() => { onSelect(entry.model); onClose(); }}>
                <strong>{entry.model.name}</strong><small>{entry.model.id}</small>
              </button>
              {entry.key === activeKey ? <em>in use</em> : null}
              <button className={`model-star ${entry.favourite ? "on" : ""}`} aria-label={entry.favourite ? `Unfavourite ${entry.model.name}` : `Favourite ${entry.model.name}`} aria-pressed={entry.favourite} onClick={() => preferences.toggleFavouriteModel(entry.key)}><Star size={14} fill={entry.favourite ? "currentColor" : "none"} /></button>
            </div>}
          />
        </div>

        <footer>
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span>⌥↵ favourite</span>
          <span className="spacer" />
          <span>{models.length} models · {providers.filter((name) => name !== FAVOURITES).length} providers</span>
        </footer>
      </section>
    </div>
  );
}
