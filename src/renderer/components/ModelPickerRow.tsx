import { Brain, Eye, EyeOff, Star } from "lucide-react";
import type { ThreadBackendKind, UiModel } from "../../shared/contracts";
import type { ModelBadgeContribution } from "../extension-system";
import { DEFAULT_RUNTIME } from "../runtime-marks";
import { billingBadge, formatPrice, formatTokens, type Offering } from "./model-offerings";
import { ProviderIconStack, providerLabel } from "./ProviderIconStack";

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
}

export function wears(badge: ModelBadgeContribution, model: UiModel, runtime: ThreadBackendKind): boolean {
  try { return badge.applies(model, runtime); } catch (error) { console.error(`Model badge ${badge.id} failed`, error); return false; }
}

/** A plan shows it is included and what the same model costs over its API; an API key what it costs. */
function PriceCell({ model }: { model: UiModel }) {
  const subscription = (model.billing ?? (model.login === "subscription" ? "subscription" : undefined)) === "subscription";
  const price = model.price;
  const title = price ? `Input $${price.input} · output $${price.output} per million tokens${price.cacheRead !== undefined ? ` · cached input $${price.cacheRead}` : ""}${subscription ? ", over the API" : ""}` : undefined;
  if (subscription) {
    return <span className="model-price" title={title ?? "Included in the plan"}><b>incl.</b>{price ? <small>API ≈ {formatPrice(price)}</small> : null}</span>;
  }
  if (price) return <span className="model-price" title={title}><b>{formatPrice(price)}</b></span>;
  if (model.billing === "free" || model.billing === "local") return <span className="model-price"><b>{model.billing}</b></span>;
  return <span className="model-price muted">—</span>;
}

/** One offering: a model as one runtime reaches it. */
export function OfferingRow({ id, offering, grouped, cross, selected, narrow, cells, onPoint, onChoose }: {
  id: string;
  offering: Offering;
  /** Under its model's heading in search: the runtime leads, the name is the heading's. */
  grouped: boolean;
  /** From a list across runtimes: the runtime is named. */
  cross: boolean;
  selected: boolean;
  narrow: boolean;
  cells: RowCell;
  onPoint(): void;
  onChoose(add: boolean): void;
}) {
  const { model, runtime } = offering;
  const access = billingBadge(model);
  const current = cells.inUse(offering.key);
  const chosen = cells.chosen(offering.key);
  const jump = cells.jump(offering.key);
  const piRuntime = runtime === DEFAULT_RUNTIME;
  const title = grouped ? `${offering.runtimeLabel}${piRuntime ? ` · ${providerLabel(model.provider)}` : ""}` : model.name;
  const levels = offering.levels.length > 1 ? offering.levels : [];
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
      <div className="model-cell-main">
        <span className="model-line">
          {grouped ? <ProviderIconStack runtimeProvider={piRuntime ? "pi" : runtime} className="sub-icon" /> : null}
          <strong>{title}</strong>
          {offering.isNew ? <span className="model-badge model-badge-new">NEW</span> : null}
          {cells.showLegacy && offering.legacy ? <span className="model-badge">legacy</span> : null}
          {access ? <span className={`model-badge model-access model-access-${access.label.toLowerCase()}`} title={access.title}>{access.label}</span> : null}
          {offering.hidden ? <span className="model-badge">hidden</span> : null}
          {current ? <em className="model-in-use">in use</em> : null}
          {chosen ? <em className="model-chosen">{chosen}</em> : null}
          {jump ? <kbd className="model-kbd">⌘{jump}</kbd> : null}
          {cells.badges.filter((badge) => wears(badge, model, runtime)).map((badge) => (
            <span key={badge.id} className={`model-badge${badge.tone === "warning" ? " model-badge-warning" : ""}`} title={badge.title}>{badge.label}</span>
          ))}
        </span>
        {grouped ? null : (
          <small className="model-sub">
            <ProviderIconStack modelProvider={model.provider} runtimeProvider={runtime} className="sub-icon" />
            {providerLabel(model.provider)}
            {cross && !piRuntime ? <span className="model-runtime">· {offering.runtimeLabel}</span> : null}
            {cross && piRuntime ? <span className="model-runtime">· Pi</span> : null}
            <span className="model-id">{model.id}</span>
            {levels.length ? <span className="model-levels" title={`Reasoning: ${levels.join(", ")}`}><Brain size={10} />{levels.length}</span> : null}
          </small>
        )}
      </div>
      {narrow ? null : <span className="model-context">{model.contextWindow ? formatTokens(model.contextWindow) : "—"}</span>}
      <PriceCell model={model} />
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
          aria-label={offering.favourite ? `Unfavourite ${model.name}` : `Favourite ${model.name}`}
          aria-pressed={offering.favourite}
          onClick={(event) => { event.stopPropagation(); cells.onFavourite(offering); }}
        >
          <Star size={13} fill={offering.favourite ? "currentColor" : "none"} />
        </button>
      </span>
    </div>
  );
}
