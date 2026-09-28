import { useState, useSyncExternalStore, type ComponentType } from "react";
import { Check, Download, Plus, ShieldCheck, SlidersHorizontal } from "lucide-react";
import type { HostSnapshot, UiRuntimeBackend } from "../../shared/contracts";
import type { SettingsPageContribution, SettingsSectionProps } from "../extension-system";
import { usePreferences } from "../renderer-services-context";
import { effectiveNewThreadRuntime } from "../new-thread-runtime";
import { useRuntimeCatalogs } from "../use-runtime-catalog";
import { READ_ONLY_REASON, useHostCapabilities } from "../use-host-capabilities";
import { ProviderIconStack, providerLabel } from "../components/ProviderIconStack";
import { Menu } from "../components/Menu";
import { tooltipProps } from "../components/ui/Tooltip";
import { Button } from "./controls";
import { SettingsPageAction } from "./page-action";
import { settingAnchor } from "./settings-search";
import { settingsTarget } from "./settings-nav";
import { runtimeRow, type RuntimeAction, type RuntimeRow } from "./runtimes-table";

/** The row id a section on this page names to be what the Permissions button opens. */
export const RUNTIME_PERMISSIONS_ROW = "runtime-permissions";

/** Marks beyond this many fold into "+N". */
const MAX_MARKS = 7;
const PI: UiRuntimeBackend = { kind: "pi", label: "Pi" };

function TalksTo({ providers }: { providers: readonly string[] }) {
  if (providers.length === 0) return <span className="runtimes-none" aria-label="No provider yet">—</span>;
  const shown = providers.slice(0, MAX_MARKS);
  const rest = providers.slice(MAX_MARKS);
  return (
    <span className="runtimes-marks">
      {shown.map((provider) => <ProviderIconStack key={provider} modelProvider={provider} hint={{ side: "top" }} />)}
      {rest.length ? <small {...tooltipProps(rest.map(providerLabel).join(", "), { side: "top" })}>+{rest.length}</small> : null}
    </span>
  );
}

const ACTION_LABELS: Record<RuntimeAction, string> = { default: "Make default", update: "Update", install: "Install", config: "Config", permissions: "Permissions" };
const ACTION_ICONS: Record<RuntimeAction, typeof Check> = { default: Check, update: Download, install: Download, config: SlidersHorizontal, permissions: ShieldCheck };

/**
 * Settings → Runtimes (design 1j): one row per runtime the host offers, with
 * its state, version, the providers it talks to and what can be done about
 * it. Installing, updating, signing in and a program's setup stay on its
 * Providers card, which the kit draws; the buttons here open that card at the
 * right row and never run anything themselves.
 */
export function RuntimesPage({ snapshot, cards, sections, onOpen, onNotify }: {
  snapshot?: HostSnapshot | undefined;
  /** The runtimes' cards on Providers. */
  cards: readonly SettingsPageContribution[];
  /** Sections kits add below the table. */
  sections: ReadonlyArray<{ id: string; rows?: ReadonlyArray<{ id: string }> | undefined; Component: ComponentType<SettingsSectionProps> }>;
  onOpen(target: string): void;
  onNotify(message: string): void;
}) {
  const preferences = usePreferences();
  const { newThreadRuntime } = useSyncExternalStore(preferences.subscribe, preferences.getSnapshot);
  const { readOnly } = useHostCapabilities();
  const catalogs = useRuntimeCatalogs(true);
  const [adding, setAdding] = useState(false);
  const backends = snapshot?.runtimeBackends?.length ? snapshot.runtimeBackends : [PI];
  const defaultKind = effectiveNewThreadRuntime(newThreadRuntime, snapshot);
  const permissions = sections.some((section) => section.rows?.some((row) => row.id === RUNTIME_PERMISSIONS_ROW));
  const cardOf = (kind: string) => cards.find((card) => card.runtime === kind);
  const rows = backends.map((backend) => runtimeRow(backend, catalogs.get(backend.kind), {
    isDefault: backend.kind === defaultKind,
    choosable: backends.length > 1,
    card: Boolean(cardOf(backend.kind)),
    permissions,
  }));
  const addable = cards.filter((card) => card.runtimeRows?.addInstance);

  const act = (row: RuntimeRow, action: RuntimeAction) => {
    const card = cardOf(row.kind);
    if (action === "default") {
      preferences.setNewThreadRuntime(row.kind);
      onNotify(`New threads start on ${row.label}.`);
    } else if (action === "permissions") onOpen(settingsTarget("runtimes", RUNTIME_PERMISSIONS_ROW));
    else if (action === "config") onOpen(row.state === "built-in" ? "pi" : card!.id);
    else if (card) onOpen(settingsTarget(card.id, card.runtimeRows?.program));
  };
  const hint = (row: RuntimeRow, action: RuntimeAction): string | undefined => {
    if (action === "default") return readOnly ? READ_ONLY_REASON : undefined;
    if (action === "permissions") return undefined;
    return row.state === "built-in" ? "Pi's own settings" : `${row.label}'s card on Providers`;
  };


  return (
    <div className="settings-page runtimes-page">
      {addable.length ? (
        <SettingsPageAction>
          <span className="menu-anchor">
            <Button variant="ghost" icon={<Plus size={14} aria-hidden />} aria-haspopup="menu" aria-expanded={adding} onClick={() => setAdding((open) => !open)}>Add a custom runtime</Button>
            {adding ? (
              <Menu
                align="right"
                heading="Another setup of"
                items={addable.map((card) => ({ id: card.id, label: card.label, icon: card.runtime ? <ProviderIconStack runtimeProvider={card.runtime} hint={false} /> : undefined, description: "Its own home, sign-in and executable" }))}
                onSelect={(id) => {
                  const card = addable.find((entry) => entry.id === id);
                  if (card) onOpen(settingsTarget(card.id, card.runtimeRows?.addInstance));
                }}
                onClose={() => setAdding(false)}
              />
            ) : null}
          </span>
        </SettingsPageAction>
      ) : null}
      <div className="runtimes-table-frame" id={settingAnchor("Runtime for new threads")} tabIndex={-1}>
        <table className="runtimes-table">
          <thead>
            <tr>
              <td className="runtimes-mark-cell" />
              <th scope="col">Runtime</th>
              <th scope="col">Version</th>
              <th scope="col">Talks to</th>
              <th scope="col" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.kind} data-state={row.state} aria-label={row.label}>
                <td className="runtimes-mark-cell"><ProviderIconStack runtimeProvider={row.kind} hint={false} className="runtimes-mark" /></td>
                <td className="runtimes-name">
                  <span>{row.label}</span>
                  {row.status.length ? (
                    <small {...tooltipProps(row.note, { side: "top" })}>{row.status.map((part, index) => <span key={part.text} data-tone={part.tone}>{index ? " · " : ""}{part.text}</span>)}</small>
                  ) : null}
                </td>
                <td className="runtimes-version">
                  {row.version.text ? <span>{row.version.text}</span> : null}
                  {row.version.tool ? <code>{row.version.tool}</code> : null}
                </td>
                <td className="runtimes-talks"><TalksTo providers={row.providers} /></td>
                <td className="runtimes-actions">
                  {row.actions.map((action) => {
                    const Icon = ACTION_ICONS[action];
                    const primary = action === "update" || action === "install";
                    return (
                      <Button
                        key={action}
                        variant={primary ? "default" : "ghost"}
                        icon={<Icon size={13} aria-hidden />}
                        aria-label={`${ACTION_LABELS[action]}: ${row.label}`}
                        disabled={action === "default" && readOnly}
                        {...tooltipProps(hint(row, action), { side: "top" })}
                        onClick={() => act(row, action)}
                      >{ACTION_LABELS[action]}</Button>
                    );
                  })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sections.map(({ id, Component }) => <Component key={id} onNotify={onNotify} onChanged={() => undefined} />)}
    </div>
  );
}
