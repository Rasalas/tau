import { SettingsFilter } from "./SettingsFilter";
import { useMemo, useState, useSyncExternalStore } from "react";
import { ArrowDown, ArrowUp, Star } from "lucide-react";
import type { TauModelPreferences, UiModel, UiRuntimeBackend } from "../../shared/contracts";
import { modelDisplayName, readModelName, readModelPreferences } from "../../shared/model-preferences";
import { billingBadge, formatPrice, formatTokens, modelKey, offeringKey, orderedPositions } from "../components/model-offerings";
import { usePreferences } from "../renderer-services-context";
import { useRuntimeCatalogs } from "../use-runtime-catalog";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { Button, SettingsState, TextField } from "./controls";
import { SettingRow, Switch, useSetting } from "./settings-layout";

/** Above this many models the list gets a filter field. */
const FILTER_THRESHOLD = 8;
const NONE: TauModelPreferences = {};

const GROUPS = ["favourite", "shown", "hidden"] as const;
type Group = typeof GROUPS[number];

/**
 * A runtime's models as the picker lists them: favourites first in the order
 * they were starred, then the rest in the user's order, the hidden ones last.
 * Moves only swap neighbours of one group; the result is what gets stored.
 */
export function arrangeModels(models: readonly UiModel[], preferences: TauModelPreferences, favourite: (model: UiModel) => number): Array<{ model: UiModel; group: Group }> {
  const positions = orderedPositions(models, preferences.order);
  const hidden = new Set(preferences.hidden);
  return models.map((model) => {
    const star = favourite(model);
    const position = positions.get(modelKey(model)) ?? 0;
    return { model, group: star >= 0 ? 0 : hidden.has(modelKey(model)) ? 2 : 1, rank: star >= 0 ? star : position, position };
  }).sort((a, b) => a.group - b.group || a.rank - b.rank || a.position - b.position)
    .map(({ model, group }) => ({ model, group: GROUPS[group]! }));
}

const GROUP_LABELS: Record<Group, string> = { favourite: "Favourites", shown: "All", hidden: "Hidden from the picker" };

/** What the list says while it has no model: on the way, or why none and what to do. */
function NoModels({ backend, entry }: { backend: UiRuntimeBackend; entry: RuntimeCatalogEntry | undefined }) {
  if (!entry || entry.status === "loading") return <SettingsState kind="loading" rows={2} title={`Loading ${backend.label}'s models`} />;
  const reason = entry.status === "unavailable" ? entry.reason : undefined;
  const description = reason === "not-installed" ? `Install ${backend.label} or set its executable above.`
    : reason === "sign-in-required" ? `Sign in to ${backend.label} above to list its models.`
      : entry.status === "unavailable" && entry.message ? entry.message
        : `${backend.label} lists them once it answers. Check it on its card above.`;
  return <SettingsState kind="empty" title={`No ${backend.label} models yet`} description={description} />;
}

/** One runtime's models: name, favourite, reorder, hide. Written to the level Settings edits. */
function RuntimeModelList({ backend, models, catalog }: { backend: UiRuntimeBackend; models: readonly UiModel[]; catalog: RuntimeCatalogEntry | undefined }) {
  const preferences = usePreferences();
  const settings = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const setting = useSetting<TauModelPreferences>(`modelPreferences.${backend.kind}`, {
    defaultValue: NONE,
    scope: "both",
    read: readModelPreferences,
    offline: (value) => preferences.setModelPreferences(backend.kind, value),
    format: (value) => `${value.hidden?.length ?? 0} hidden${value.order?.length ? ", reordered" : ""}`,
  });
  const [filter, setFilter] = useState("");
  const value = setting.value;
  const arranged = useMemo(() => {
    const starred = settings.favouriteModels;
    return arrangeModels(models, value, (model) => starred.indexOf(offeringKey(backend.kind, model)));
  }, [backend.kind, models, settings.favouriteModels, value]);
  const hidden = new Set(value.hidden);
  const needle = filter.trim().toLowerCase();
  const visible = needle ? arranged.filter(({ model }) => `${modelDisplayName(model, value)} ${model.name} ${model.id}`.toLowerCase().includes(needle)) : arranged;
  const allHidden = models.length > 0 && models.every((model) => hidden.has(modelKey(model)));
  const favourites = arranged.filter((entry) => entry.group === "favourite").length;

  const write = (next: TauModelPreferences) => setting.set(readModelPreferences(next)!);
  const rename = (model: UiModel, text: string) => {
    const names = { ...value.names };
    const name = readModelName(text);
    if (name) names[modelKey(model)] = name;
    else delete names[modelKey(model)];
    write({ ...value, names });
  };
  const setHidden = (model: UiModel, hide: boolean) => {
    const key = modelKey(model);
    const held = value.hidden ?? [];
    write({ ...value, hidden: hide ? [...held, key] : held.filter((entry) => entry !== key) });
  };
  const move = (index: number, delta: -1 | 1) => {
    const other = arranged[index + delta];
    if (!other || other.group !== arranged[index]!.group) return;
    const keys = arranged.filter((entry) => entry.group !== "favourite").map((entry) => modelKey(entry.model));
    const from = keys.indexOf(modelKey(arranged[index]!.model));
    const to = keys.indexOf(modelKey(other.model));
    if (from < 0 || to < 0) return;
    [keys[from], keys[to]] = [keys[to]!, keys[from]!];
    write({ ...value, order: keys });
  };

  return (
    <SettingRow
      id={`runtime-models-${backend.kind}`}
      title={`${backend.label} models`}
      description={`${models.length} ${models.length === 1 ? "model" : "models"}${favourites ? ` · ${favourites} ${favourites === 1 ? "favourite" : "favourites"}` : ""}${hidden.size ? ` · ${hidden.size} hidden` : ""}. Blank names keep catalog labels.`}
      setting={setting}
      control={models.length ? (
        <Button variant="ghost" disabled={!setting.writable} onClick={() => write({ ...value, hidden: allHidden ? [] : models.map(modelKey) })}>
          {allHidden ? "Show all" : "Hide all"}
        </Button>
      ) : undefined}
    >
      {models.length > FILTER_THRESHOLD ? (
        <SettingsFilter className="runtime-models-filter" label={`Filter ${backend.label} models`} placeholder="Filter models" value={filter} onChange={setFilter} spellCheck={false} />
      ) : null}
      <div className="runtime-models" role="list" aria-label={`${backend.label} models`}>
        {models.length === 0 ? <NoModels backend={backend} entry={catalog} /> : null}
        {visible.map(({ model, group }, index) => {
          const at = arranged.findIndex((entry) => entry.model === model);
          const key = modelKey(model);
          const startsGroup = !needle && (index === 0 || visible[index - 1]!.group !== group) && (group !== "shown" || favourites > 0);
          const isHidden = hidden.has(key);
          const access = billingBadge(model);
          return (
            <div key={key} role="listitem" className="runtime-model-entry">
              {startsGroup ? <div className="runtime-models-group">{GROUP_LABELS[group]}</div> : null}
              <div className={`runtime-model${isHidden ? " hidden" : ""}`}>
                <button
                  type="button"
                  className={`runtime-model-star${group === "favourite" ? " on" : ""}`}
                  aria-label={group === "favourite" ? `Unfavourite ${model.name}` : `Favourite ${model.name}`}
                  aria-pressed={group === "favourite"}
                  onClick={() => preferences.toggleFavouriteModel(offeringKey(backend.kind, model))}
                ><Star size={12} fill={group === "favourite" ? "currentColor" : "none"} /></button>
                <span className="runtime-model-name">
                  <TextField label={`Display name for ${model.name}`} value={value.names?.[key] ?? ""} placeholder={model.name} width="full" disabled={!setting.writable}
                    validate={(text) => text.trim() && !readModelName(text) ? "Use up to 120 characters on one line." : undefined}
                    onCommit={(text) => rename(model, text)} />
                  <code>{model.id}</code>
                </span>
                <span className="runtime-model-facts">
                  {access ? <span>{access.label}</span> : null}
                  {model.contextWindow ? <span>{formatTokens(model.contextWindow)}</span> : null}
                  {model.price ? <span>{formatPrice(model.price)}</span> : null}
                </span>
                <span className="runtime-model-moves">
                  {needle || group === "hidden" ? null : <>
                    <button type="button" aria-label={`Move ${model.name} up`} disabled={!setting.writable || arranged[at - 1]?.group !== group || group === "favourite"} onClick={() => move(at, -1)}><ArrowUp size={12} /></button>
                    <button type="button" aria-label={`Move ${model.name} down`} disabled={!setting.writable || arranged[at + 1]?.group !== group || group === "favourite"} onClick={() => move(at, 1)}><ArrowDown size={12} /></button>
                  </>}
                </span>
                <Switch label={`Show ${model.name} in the model picker`} checked={!isHidden} disabled={!setting.writable} onChange={(checked) => setHidden(model, !checked)} />
              </div>
            </div>
          );
        })}
        {needle && visible.length === 0 ? (
          <SettingsState kind="empty" title={`No ${backend.label} model matches “${filter.trim()}”`} action={<Button onClick={() => setFilter("")}>Show all models</Button>} />
        ) : null}
      </div>
    </SettingRow>
  );
}

/** Every runtime's models, from the host's catalogs; Pi's included. */
export function RuntimeModels({ backends }: { backends: readonly UiRuntimeBackend[] }) {
  const catalogs = useRuntimeCatalogs(true);
  return (
    <>
      {backends.map((backend) => {
        const entry = catalogs.get(backend.kind);
        const models = entry?.status === "ready" ? entry.catalog.models : entry?.status === "unavailable" ? entry.catalog?.models ?? [] : [];
        return <RuntimeModelList key={backend.kind} backend={backend} models={models} catalog={entry} />;
      })}
    </>
  );
}
