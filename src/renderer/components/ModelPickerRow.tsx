import { Eye, EyeOff, Star } from "lucide-react";
import type { ReactNode } from "react";
import type { ThreadBackendKind, UiModel } from "../../shared/contracts";
import type { ModelBadgeContribution } from "../extension-system";
import { billingBadge, modelBilling, formatPrice, formatTokens, type Offering } from "./model-offerings";
import { entryFacts, modelMaker, type ModelEntry } from "./model-entries";
import { ProviderIconStack, providerLabel } from "./ProviderIconStack";
import { monogram } from "../runtime-marks";
import { runtimeInstanceId } from "../../shared/runtime-instances";

/** What every row of one list shares: marks, the model in use, the chosen set and the row actions. */
export interface RowCell {
  badges: readonly ModelBadgeContribution[];
  inUse(entry: ModelEntry, way: Offering | undefined): boolean;
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
  /** What the highlighted row adds to its second line: a plan's rest, or that it starts a new thread. */
  more(way: Offering): ReactNode;
}

/**
 * What a row's second line says: every runtime that runs the model ("marks", a maker's "All"),
 * the way with its runtime ("runtime", Favourites and Recent), or the way alone under a runtime's filter ("route").
 */
export type RowLine = "marks" | "runtime" | "route";

export function wears(badge: ModelBadgeContribution, model: UiModel, runtime: ThreadBackendKind): boolean {
  try { return badge.applies(model, runtime); } catch (error) { console.error(`Model badge ${badge.id} failed`, error); return false; }
}

/** How a way is had: "Plan", "API key", "Free" through the maker itself; a gateway by its name. */
export function wayText(way: Offering): string {
  const billing = modelBilling(way.model);
  const own = modelMaker({ provider: way.model.provider, id: "" }) === modelMaker(way.model) || way.model.provider === way.runtime;
  if (!own) return providerLabel(way.model.provider);
  return billing === "subscription" ? "Plan" : billing === "free" ? "Free" : billing === "local" ? "Local" : "API key";
}

/** One way's context and, off a plan, its price. */
function wayFacts(way: Offering): string[] {
  const { contextWindow, price } = way.model;
  return [
    ...(contextWindow ? [formatTokens(contextWindow)] : []),
    ...(price && modelBilling(way.model) !== "subscription" ? [formatPrice(price)] : []),
  ];
}

/** A maker as the rail draws it: by its product's mark. */
export function MakerMark({ maker }: { maker: string }) {
  return <ProviderIconStack modelProvider={maker} brand className="rail-icon" hint={false} />;
}

/** A runtime as the rail draws it: its mark, and a second instance of one program with its initials on it. */
export function RuntimeMark({ kind }: { kind: ThreadBackendKind }) {
  return <>
    <ProviderIconStack runtimeProvider={kind} className="rail-icon" hint={false} />
    {kind.includes("@") ? <i className="rail-instance" aria-hidden>{monogram(runtimeInstanceId(kind))}</i> : null}
  </>;
}

/** The runtimes a model runs on, as their marks; the names are in the tooltip. */
export function RuntimeMarks({ ways }: { ways: readonly Offering[] }) {
  const runtimes = [...new Map(ways.map((way) => [way.runtime, way.runtimeLabel] as const))];
  return (
    <span className="model-runtimes">
      {runtimes.map(([runtime, label]) => <ProviderIconStack key={runtime} runtimeProvider={runtime} runtimeName={label} className="row-icon" hint={{ side: "top" }} />)}
    </span>
  );
}

/** One model with the way chosen for it (`way`): its name, then how it runs and what it reads and costs. */
export function EntryRow({ id, entry, way, line, selected, cells, onPoint, onLeave, onChoose }: {
  id: string;
  entry: ModelEntry;
  way: Offering;
  line: RowLine;
  selected: boolean;
  cells: RowCell;
  onPoint(): void;
  onLeave(): void;
  onChoose(add: boolean): void;
}) {
  const { model, runtime } = way;
  const name = way.name ?? entry.name;
  const access = billingBadge(model);
  const ways = line === "marks" ? entry.ways : [way];
  const current = cells.inUse(entry, line === "marks" ? undefined : way);
  const chosen = cells.chosen(way);
  const jump = cells.jump(way.key);
  const level = cells.level(way);
  const hidden = ways.every((item) => item.hidden);
  const legacy = ways.every((item) => item.legacy);
  const facts = line === "marks" ? entryFacts(entry.ways) : [line === "runtime" ? `${way.runtimeLabel} · ${wayText(way)}` : wayText(way), ...wayFacts(way)].join(" · ");
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      aria-label={`${name}, ${way.runtimeLabel}${line === "marks" ? "" : `, ${wayText(way)}`}${access && line === "marks" ? `, ${access.label}` : ""}${current ? ", in use" : ""}`}
      data-provider={entry.maker}
      className={`model-row${selected ? " selected" : ""}${current ? " current" : ""}${hidden ? " hidden-model" : ""}`}
      onMouseEnter={onPoint}
      onMouseLeave={onLeave}
      onClick={(event) => onChoose(event.shiftKey)}
    >
      <span className="model-text">
        <span className="model-line">
          <strong>{name}</strong>
          {ways.some((item) => item.isNew) ? <span className="model-badge model-badge-new">NEW</span> : null}
          {cells.showLegacy && legacy ? <span className="model-badge">legacy</span> : null}
          {hidden ? <span className="model-badge">hidden</span> : null}
          {chosen ? <em className="model-chosen">{chosen}</em> : null}
          {level ? <em className="model-chosen">{level}</em> : null}
          {cells.badges.filter((badge) => wears(badge, model, runtime)).map((badge) => (
            <span key={badge.id} className={`model-badge${badge.tone === "warning" ? " model-badge-warning" : ""}`} title={badge.title}>{badge.label}</span>
          ))}
        </span>
        <small className="model-facts">
          {line === "marks" ? <RuntimeMarks ways={entry.ways} /> : null}
          {line === "runtime" ? <ProviderIconStack runtimeProvider={runtime} runtimeName={way.runtimeLabel} className="row-icon" hint={false} /> : null}
          {facts || selected ? <span>{facts}{selected ? cells.more(way) : null}</span> : null}
        </small>
      </span>
      {jump ? <kbd className="model-kbd">⌘{jump}</kbd> : null}
      <span className="model-row-actions">
        <button
          className="model-row-action model-hide"
          tabIndex={-1}
          aria-label={hidden ? `Show ${name} in the picker` : `Hide ${name} from the picker`}
          title={hidden ? "Show in the picker" : "Hide from the picker"}
          onClick={(event) => { event.stopPropagation(); cells.onHide(entry); }}
        >
          {hidden ? <Eye size={13} /> : <EyeOff size={13} />}
        </button>
        <button
          className={`model-row-action model-star ${way.favourite ? "on" : ""}`}
          tabIndex={-1}
          aria-label={way.favourite ? `Unpin ${name} on ${way.runtimeLabel}` : `Pin ${name} on ${way.runtimeLabel}`}
          title={way.favourite ? "Pinned with this way to run it" : "Pin it with this way to run it"}
          aria-pressed={way.favourite}
          onClick={(event) => { event.stopPropagation(); cells.onFavourite(way); }}
        >
          <Star size={13} fill={way.favourite ? "currentColor" : "none"} />
        </button>
      </span>
    </div>
  );
}
