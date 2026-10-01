import { Check, Eye, EyeOff, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel } from "../../shared/contracts";
import type { ModelBadgeContribution } from "../extension-system";
import { billingBadge, formatPrice, formatTokens, type Offering } from "./model-offerings";
import { entryFacts, type ModelEntry } from "./model-entries";
import { ProviderIconStack } from "./ProviderIconStack";

/** What every row of one list shares: marks, the model in use, the chosen set and the row actions. */
export interface RowCell {
  badges: readonly ModelBadgeContribution[];
  inUse(entry: ModelEntry): boolean;
  /** "added" or "×2" for a model in a new thread's set. */
  chosen(way: Offering): string | undefined;
  /** ⌘n reaches it. */
  jump(key: string): number | undefined;
  /** In "Recent": the thinking level the model was last used with. */
  level(way: Offering): string | undefined;
  onFavourite(way: Offering): void;
  onHide(entry: ModelEntry): void;
  /** Search lists legacy models flat, tagged. */
  showLegacy: boolean;
}

export function wears(badge: ModelBadgeContribution, model: UiModel, runtime: ThreadBackendKind): boolean {
  try { return badge.applies(model, runtime); } catch (error) { console.error(`Model badge ${badge.id} failed`, error); return false; }
}

/** The runtimes a model runs on, as their marks; the names are in the tooltip. */
export function RuntimeMarks({ ways }: { ways: readonly Offering[] }) {
  const runtimes = [...new Map(ways.map((way) => [way.runtime, way.runtimeLabel] as const))];
  return (
    <span className="model-runtimes">
      {runtimes.map(([runtime, label]) => <ProviderIconStack key={runtime} runtimeProvider={runtime} runtimeName={label} className="sub-icon" hint={{ side: "top" }} />)}
    </span>
  );
}

/** One model, once, with the way chosen for it (`way`): its name, what it reads and costs, the runtimes that run it. */
export function EntryRow({ id, entry, way, selected, cells, onPoint, onLeave, onChoose }: {
  id: string;
  entry: ModelEntry;
  way: Offering;
  selected: boolean;
  cells: RowCell;
  onPoint(): void;
  onLeave(): void;
  onChoose(add: boolean): void;
}) {
  const { model, runtime } = way;
  const access = billingBadge(model);
  const current = cells.inUse(entry);
  const chosen = cells.chosen(way);
  const jump = cells.jump(way.key);
  const level = cells.level(way);
  const hidden = entry.ways.every((item) => item.hidden);
  const legacy = entry.ways.every((item) => item.legacy);
  const facts = entryFacts(entry.ways);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${entry.name}, ${way.runtimeLabel}${access ? `, ${access.label}` : ""}${current ? ", in use" : ""}`}
      data-provider={entry.maker}
      className={`model-row${selected ? " selected" : ""}${current ? " current" : ""}${hidden ? " hidden-model" : ""}`}
      onMouseEnter={onPoint}
      onMouseLeave={onLeave}
      onClick={(event) => onChoose(event.shiftKey)}
    >
      <span className="model-text">
        <span className="model-line">
          <strong>{entry.name}</strong>
          {entry.ways.some((item) => item.isNew) ? <span className="model-badge model-badge-new">NEW</span> : null}
          {cells.showLegacy && legacy ? <span className="model-badge">legacy</span> : null}
          {hidden ? <span className="model-badge">hidden</span> : null}
          {chosen ? <em className="model-chosen">{chosen}</em> : null}
          {level ? <em className="model-chosen">{level}</em> : null}
          {cells.badges.filter((badge) => wears(badge, model, runtime)).map((badge) => (
            <span key={badge.id} className={`model-badge${badge.tone === "warning" ? " model-badge-warning" : ""}`} title={badge.title}>{badge.label}</span>
          ))}
        </span>
        {facts ? <small className="model-facts">{facts}</small> : null}
      </span>
      <RuntimeMarks ways={entry.ways} />
      {jump ? <kbd className="model-kbd keyboard-hint">⌘{jump}</kbd> : null}
      <span className="model-row-actions">
        <button
          className="model-row-action model-hide"
          tabIndex={-1}
          aria-label={hidden ? `Show ${entry.name} in the picker` : `Hide ${entry.name} from the picker`}
          title={hidden ? "Show in the picker" : "Hide from the picker"}
          onClick={(event) => { event.stopPropagation(); cells.onHide(entry); }}
        >
          {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button
          className={`model-row-action model-star ${way.favourite ? "on" : ""}`}
          tabIndex={-1}
          aria-label={way.favourite ? `Unpin ${entry.name} on ${way.runtimeLabel}` : `Pin ${entry.name} on ${way.runtimeLabel}`}
          title={way.favourite ? "Pinned with this way to run it" : "Pin it with this way to run it"}
          aria-pressed={way.favourite}
          onClick={(event) => { event.stopPropagation(); cells.onFavourite(way); }}
        >
          <Star size={13} fill={way.favourite ? "currentColor" : "none"} />
        </button>
      </span>
      <span className="model-check" aria-hidden>{current ? <Check size={14} /> : null}</span>
    </div>
  );
}

/**
 * What a model reads and costs, for the line under "Runs with":
 * its context, how it is paid, and its price per million tokens (over the API
 * for a plan, which includes it).
 */
export function modelFacts(model: UiModel, customPrice = false): string[] {
  const facts: string[] = [];
  if (model.contextWindow) facts.push(`${formatTokens(model.contextWindow)} context`);
  const billing = model.billing ?? (model.login === "subscription" ? "subscription" : undefined);
  const price = model.price ? `${formatPrice(model.price)} per MTok${customPrice ? " (your price)" : ""}` : undefined;
  if (billing === "subscription") facts.push("in the plan", ...(price ? [`API ≈ ${price}`] : []));
  else if (price) facts.push(price);
  else if (billing === "free" || billing === "local") facts.push(billing);
  else if (billing === "api-key") facts.push("API key");
  return facts;
}
