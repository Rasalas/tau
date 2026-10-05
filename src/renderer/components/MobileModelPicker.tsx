import { useState } from "react";
import { ChevronDown, ChevronUp, Search, Star } from "lucide-react";
import { Sheet } from "../touch/Sheet";
import { ProviderIconStack } from "./ProviderIconStack";
import type { Offering } from "./model-offerings";
import type { ReactNode } from "react";

export function MobileModelPicker({ offerings, activeKey, onChoose, onFavourite, onClose, thinking, unavailable }: {
  offerings: readonly Offering[];
  activeKey: string | undefined;
  onChoose(way: Offering): void;
  onFavourite(key: string): void;
  onClose(): void;
  thinking: ReactNode;
  unavailable?: ReactNode;
}) {
  const [query, setQuery] = useState("");
  const [favourites, setFavourites] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlyMap<string, boolean>>(new Map());
  const groups = new Map<string, Offering[]>();
  for (const way of offerings) {
    if (!query.trim() && way.legacy && !way.favourite && way.key !== activeKey) continue;
    if (favourites && !way.favourite) continue;
    if (!`${way.model.name} ${way.runtimeLabel}`.toLowerCase().includes(query.toLowerCase())) continue;
    const group = groups.get(way.runtime) ?? [];
    group.push(way);
    groups.set(way.runtime, group);
  }
  return <Sheet title="Thread settings" presentation="page" className="mobile-model-picker" onClose={onClose}>
    <div className="mobile-model-search"><Search size={22} /><input aria-label="Find a model" placeholder="Find a model" value={query} onChange={(event) => setQuery(event.target.value)} /><button aria-label="Show favourite models" aria-pressed={favourites} onClick={() => setFavourites((value) => !value)}><Star size={22} fill={favourites ? "currentColor" : "none"} /></button></div>
    {[...groups].sort(([a], [b]) => runtimeRank(a) - runtimeRank(b)).map(([runtime, ways]) => {
      const open = query.length > 0 || (expanded.get(runtime) ?? ways.length <= 20);
      return <section key={runtime}>
      <button className="mobile-model-group" aria-expanded={open} onClick={() => setExpanded((previous) => new Map(previous).set(runtime, !open))}>
        <ProviderIconStack runtimeProvider={runtime} hint={false} /><span>{ways[0]!.runtimeLabel}</span>{!open ? <small>{ways.length}</small> : null}{!open ? <ChevronDown size={16} /> : <ChevronUp size={16} />}
      </button>
      {!open ? null : <div className="mobile-choice-card" role="radiogroup" aria-label={`${ways[0]!.runtimeLabel} models`}>{ways.map((way) => <div key={way.key} className="mobile-model-row" data-current={way.key === activeKey || undefined}>
        <button className="mobile-model-choice" role="radio" aria-checked={way.key === activeKey} onClick={() => onChoose(way)}><i aria-hidden />{way.model.name}</button>
        <button className="mobile-model-star" aria-label={`Favourite ${way.model.name}`} aria-pressed={way.favourite} onClick={() => onFavourite(way.key)}><Star size={22} fill={way.favourite ? "currentColor" : "none"} /></button>
      </div>)}</div>}
    </section>; })}
    {groups.size ? null : <p>No matching models</p>}
    {unavailable}
    {thinking}
  </Sheet>;
}

function runtimeRank(runtime: string): number {
  const rank = ["codex", "claude-code", "opencode", "antigravity", "pi"].indexOf(runtime);
  return rank < 0 ? 5 : rank;
}
