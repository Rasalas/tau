import { Check, Eye, EyeOff, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel } from "../../shared/contracts";
import type { ModelBadgeContribution } from "../extension-system";
import { modelOnPlan } from "../runtime-marks";
import { billingBadge, formatPrice, formatTokens, type Offering } from "./model-offerings";
import { ProviderIconStack } from "./ProviderIconStack";

/** What every row of one list shares: marks, the model in use, the chosen set and the row actions. */
export interface RowCell {
  badges: readonly ModelBadgeContribution[];
  inUse(key: string): boolean;
  /** "added" or "×2" for a model in a new thread's set. */
  chosen(key: string): string | undefined;
  /** ⌘n reaches it. */
  jump(key: string): number | undefined;
  onFavourite(offering: Offering): void;
  onHide(offering: Offering): void;
  /** Search lists legacy models flat, tagged. */
  showLegacy: boolean;
  /** The list mixes model providers, so a row carries its provider's mark. */
  showProvider: boolean;
}

export function wears(badge: ModelBadgeContribution, model: UiModel, runtime: ThreadBackendKind): boolean {
  try { return badge.applies(model, runtime); } catch (error) { console.error(`Model badge ${badge.id} failed`, error); return false; }
}

const HINT = { side: "top" } as const;

/** A route to a model across runtimes: the access mark with the runtime's behind it, or the runtime's own mark at home. */
export function OfferingMarks({ offering }: { offering: Offering }) {
  const { runtime, runtimeLabel, model } = offering;
  return (
    <span className="model-marks">
      <ProviderIconStack modelProvider={model.provider} runtimeProvider={runtime} plan={modelOnPlan(model)} modelName={model.name} runtimeName={runtimeLabel} className="sub-icon" hint={HINT} />
    </span>
  );
}

/** In one runtime's list, which the rail names: the access mark without the runtime's, still named. */
function ListMarks({ offering }: { offering: Offering }) {
  const { runtime, runtimeLabel, model } = offering;
  return (
    <span className="model-marks">
      <ProviderIconStack modelProvider={model.provider} runtimeProvider={runtime} plan={modelOnPlan(model)} runtimeMark={false} modelName={model.name} runtimeName={runtimeLabel} className="sub-icon" hint={HINT} />
    </span>
  );
}

/** One offering, on one line: a model as one runtime reaches it. Context and price are the picker's detail line. */
export function OfferingRow({ id, offering, grouped, cross, selected, cells, onPoint, onChoose }: {
  id: string;
  offering: Offering;
  /** Under its model's heading in search: the marks stand in for the name, which is the heading's. */
  grouped: boolean;
  /** From a list across runtimes: the runtime's mark leads. */
  cross: boolean;
  selected: boolean;
  cells: RowCell;
  onPoint(): void;
  onChoose(add: boolean): void;
}) {
  const { model, runtime } = offering;
  const access = billingBadge(model);
  const current = cells.inUse(offering.key);
  const chosen = cells.chosen(offering.key);
  const jump = cells.jump(offering.key);
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${model.name}, ${offering.runtimeLabel}${access ? `, ${access.label}` : ""}${current ? ", in use" : ""}`}
      data-provider={model.provider}
      className={`model-row${grouped ? " grouped" : ""}${selected ? " selected" : ""}${current ? " current" : ""}${offering.hidden ? " hidden-model" : ""}`}
      onMouseMove={onPoint}
      onClick={(event) => onChoose(event.shiftKey)}
    >
      {grouped || cross ? <OfferingMarks offering={offering} /> : cells.showProvider ? <ListMarks offering={offering} /> : null}
      <span className="model-line">
        {grouped ? null : <strong>{model.name}</strong>}
        {offering.isNew ? <span className="model-badge model-badge-new">NEW</span> : null}
        {cells.showLegacy && offering.legacy ? <span className="model-badge">legacy</span> : null}
        {offering.hidden ? <span className="model-badge">hidden</span> : null}
        {chosen ? <em className="model-chosen">{chosen}</em> : null}
        {cells.badges.filter((badge) => wears(badge, model, runtime)).map((badge) => (
          <span key={badge.id} className={`model-badge${badge.tone === "warning" ? " model-badge-warning" : ""}`} title={badge.title}>{badge.label}</span>
        ))}
      </span>
      {jump ? <kbd className="model-kbd keyboard-hint">⌘{jump}</kbd> : null}
      <span className="model-row-actions">
        <button
          className="model-row-action model-hide"
          tabIndex={-1}
          aria-label={offering.hidden ? `Show ${model.name} in the picker` : `Hide ${model.name} from the picker`}
          title={offering.hidden ? "Show in the picker" : "Hide from the picker"}
          onClick={(event) => { event.stopPropagation(); cells.onHide(offering); }}
        >
          {offering.hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button
          className={`model-row-action model-star ${offering.favourite ? "on" : ""}`}
          tabIndex={-1}
          aria-label={offering.favourite ? `Unpin ${model.name}` : `Pin ${model.name}`}
          title={offering.favourite ? "Pinned: listed first and in Favourites" : "Pin: list it first and in Favourites"}
          aria-pressed={offering.favourite}
          onClick={(event) => { event.stopPropagation(); cells.onFavourite(offering); }}
        >
          <Star size={13} fill={offering.favourite ? "currentColor" : "none"} />
        </button>
      </span>
      <span className="model-check" aria-hidden>{current ? <Check size={14} /> : null}</span>
    </div>
  );
}

/**
 * What a model reads and costs, for the picker's detail line:
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
