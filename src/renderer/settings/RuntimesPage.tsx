import { useState, useSyncExternalStore, type ComponentType } from "react";
import { ChevronRight, Plus, Star } from "lucide-react";
import type { HostSnapshot, UiRuntimeBackend } from "../../shared/contracts";
import type { SettingsPageContribution, SettingsSectionProps } from "../extension-system";
import { usePreferences } from "../renderer-services-context";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { useRuntimeCatalogs } from "../use-runtime-catalog";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { Menu } from "../components/Menu";
import { tooltipProps } from "../components/ui/Tooltip";
import { Button } from "./controls";
import { SettingsPageAction } from "./page-action";
import { RuntimeDetail, RuntimeEnabledSwitch, StateLine, useRuntimeEnabled } from "./RuntimeDetail";
import { runtimeRow, type RuntimeRow } from "./runtimes-table";
import { RuntimeToolsSection } from "./RuntimeToolsSection";
import { settingAnchor } from "./settings-search";
import { runtimePage, settingsTarget } from "./settings-nav";

const PI: UiRuntimeBackend = { kind: "pi", label: "Pi" };

/** One runtime in the list: open it, see its state, and switch it on or off. */
function RuntimeListItem({ row, selected, onOpen }: { row: RuntimeRow; selected: boolean; onOpen(): void }) {
  const enabled = useRuntimeEnabled(row.kind);
  return (
    <li className="runtimes-item" data-selected={selected ? "" : undefined} data-off={enabled.value ? undefined : ""}>
      <button type="button" className="runtimes-item-open" aria-current={selected ? "true" : undefined} onClick={onOpen}>
        <ProviderIconStack runtimeProvider={row.kind} hint={false} className="runtimes-mark" />
        <span className="runtimes-item-text">
          <b>{row.label}</b>
          <small {...tooltipProps(row.note, { side: "top" })}>
            <StateLine row={row} />
          </small>
        </span>
        <span className="runtimes-item-end">
          {row.isDefault ? <span className="runtimes-default" {...tooltipProps(`New threads start on ${row.label}`, { side: "top" })} role="img" aria-label="New threads start here"><Star size={14} aria-hidden fill="currentColor" /></span> : null}
          <ChevronRight size={14} className="runtimes-chevron" aria-hidden />
        </span>
      </button>
      <RuntimeEnabledSwitch setting={enabled} label={row.label} />
    </li>
  );
}

/**
 * Settings → Runtimes (design 1j): the runtimes the host offers as a list with
 * their state, and the one chosen beside it with its program, sign-in, models
 * and default model. Where the page is narrow, or on a phone, the list is the
 * page and a runtime opens as `runtimes/<kind>` under it. The program, sign-in
 * and second setups are the runtime's kit's rows, drawn in the detail.
 */
export function RuntimesPage({ snapshot, cards, sections, selected, stacked = false, onSelect, onOpen, onNotify }: {
  snapshot?: HostSnapshot | undefined;
  /** The runtimes' cards, from the kits that registered a settings page with a `runtime`. */
  cards: readonly SettingsPageContribution[];
  /** Sections kits add below the list. */
  sections: ReadonlyArray<{ id: string; Component: ComponentType<SettingsSectionProps> }>;
  /** The runtime the page was opened on (`runtimes/<kind>`); none shows the default one beside the list. */
  selected?: string | undefined;
  /** One column, as on a phone: the list or the detail, never both. */
  stacked?: boolean;
  /** Chooses a runtime, or none to go back to the list. */
  onSelect(kind: string | undefined): void;
  onOpen(target: string): void;
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
}) {
  const preferences = usePreferences();
  const { newThreadRuntime } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const catalogs = useRuntimeCatalogs(true);
  const [adding, setAdding] = useState(false);
  const backends = snapshot?.runtimeBackends?.length ? snapshot.runtimeBackends : [PI];
  const defaultKind = effectiveNewThreadRuntime(newThreadRuntime, snapshot, catalogs);
  const cardOf = (kind: string) => cards.find((card) => card.runtime === kind);
  const rows = backends.map((backend) => runtimeRow(backend, catalogs.get(backend.kind), { isDefault: backend.kind === defaultKind, card: Boolean(cardOf(backend.kind)) }));
  const chosen = backends.find((backend) => backend.kind === selected);
  const current = chosen ?? backends.find((backend) => backend.kind === defaultKind) ?? backends[0]!;
  const currentRow = rows.find((row) => row.kind === current.kind)!;
  const currentCard = cardOf(current.kind);
  const addable = cards.filter((card) => card.runtime && card.runtimeRows?.addInstance);
  const view = chosen ? "detail" : "list";
  const defaultBackend = backends.find((backend) => backend.kind === defaultKind);

  return (
    <div className="settings-page runtimes-page">
      {addable.length ? (
        <SettingsPageAction>
          <span className="menu-anchor">
            <Button variant="ghost" icon={<Plus size={14} aria-hidden />} aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>Add instance</Button>
            {adding ? (
              <Menu
                align="right"
                heading="Another setup of"
                items={addable.map((card) => ({ id: card.id, label: card.label, icon: card.runtime ? <ProviderIconStack runtimeProvider={card.runtime} hint={false} /> : undefined, description: "Its own home, sign-in and executable" }))}
                onSelect={(id) => {
                  const card = addable.find((entry) => entry.id === id);
                  if (card?.runtime) onOpen(settingsTarget(runtimePage(card.runtime), card.runtimeRows?.addInstance));
                }}
                onClose={() => setAdding(false)}
              />
            ) : null}
          </span>
        </SettingsPageAction>
      ) : null}

      {defaultBackend && !(stacked && chosen) ? (
        <p className="runtimes-summary">
          New threads start on <ProviderIconStack runtimeProvider={defaultBackend.kind} hint={false} className="runtimes-mark" /> <b>{defaultBackend.label}</b>. The star on a runtime marks it; the composer can still pick another per thread.
        </p>
      ) : null}

      <div className="runtimes-md" id={settingAnchor("Runtime for new threads")} tabIndex={-1} data-view={view} data-narrow={stacked ? "" : undefined}>
        {stacked && chosen ? null : (
          <div className="runtimes-list">
            <div className="runtimes-list-head">{rows.length} {rows.length === 1 ? "runtime" : "runtimes"}</div>
            <ul aria-label="Runtimes">
              {rows.map((row) => <RuntimeListItem key={row.kind} row={row} selected={row.kind === current.kind} onOpen={() => onSelect(row.kind)} />)}
            </ul>
          </div>
        )}
        {stacked && !chosen ? null : (
          <RuntimeDetail
            key={current.kind}
            backend={current}
            row={currentRow}
            card={currentCard}
            snapshot={snapshot}
            onBack={stacked ? undefined : () => onSelect(undefined)}
            onMakeDefault={() => {
              preferences.setNewThreadRuntime(current.kind);
              onNotify(`New threads start on ${current.label}.`);
            }}
            onOpenProgram={() => onOpen(settingsTarget(runtimePage(current.kind), currentCard?.runtimeRows?.program))}
            onNotify={onNotify}
          />
        )}
      </div>

      {sections.map(({ id, Component }) => <Component key={id} onNotify={onNotify} onChanged={() => undefined} />)}
      {/* Not in the design; below what it shows (K150). */}
      <RuntimeToolsSection onNotify={onNotify} />
    </div>
  );
}
