import { useCallback, useState } from "react";
import { ChevronLeft, Plus, Star, Undo2 } from "lucide-react";
import type { HostSnapshot, UiRuntimeBackend } from "../../shared/contracts";
import type { SettingsPageContribution } from "../extension-system";
import { AddModelProviderModal } from "../components/AddModelProviderModal";
import { ProviderIconStack, providerLabel } from "../components/ProviderIconStack";
import { tooltipProps } from "../components/ui/Tooltip";
import { READ_ONLY_REASON, useHostCapabilities } from "../use-host-capabilities";
import { Badge, Button, Switch } from "./controls";
import { ProviderCardContext, type ProviderCardBadge, type ProviderCardBadgeSource } from "./provider-card-state";
import { PiAdvanced, PiDefaults, usePiConfig } from "./PiSettings";
import { RuntimeModels } from "./RuntimeModels";
import type { RuntimeRow, RuntimeTone } from "./runtimes-table";
import { SettingOrigin, SettingRow, SettingsSection, useSetting, type SettingHandle } from "./settings-layout";
import { settingAnchor } from "./settings-search";

const SOURCES: readonly ProviderCardBadgeSource[] = ["program", "account"];

/** Marks beyond this many fold into "+N". */
const MAX_MARKS = 7;

const readEnabled = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

/** Whether a runtime may start work on this machine and in the project being edited (ADR 0033). The kit stays active either way. */
export function useRuntimeEnabled(kind: string): SettingHandle<boolean> {
  return useSetting<boolean>(`runtimeEnabled.${kind}`, { defaultValue: true, scope: "both", read: readEnabled });
}

/** Why the switch is inert when the level being edited or the pairing cannot hold it. */
function inertReason(setting: { lock?: string | undefined; readOnly?: boolean | undefined }): string {
  return setting.readOnly ? "This device is paired Read only: it can see settings, not change them." : setting.lock ?? "This setting cannot be changed here.";
}

/** The "Use <runtime>" switch; `detailed` adds where its value comes from and the way back to the inherited one. */
export function RuntimeEnabledSwitch({ setting, label, detailed = false }: { setting: SettingHandle<boolean>; label: string; detailed?: boolean }) {
  const resettable = detailed && setting.writable && setting.origin === setting.editing;
  return (
    <span className="runtime-switch" {...tooltipProps(setting.writable ? undefined : inertReason(setting), { side: "top" })}>
      {detailed ? <SettingOrigin setting={setting} /> : null}
      {resettable ? (
        <button type="button" className="setting-reset" aria-label={`Reset ${label} to ${setting.editing === "project" ? "inherited value" : "default"}`} title={setting.editing === "project" ? "Reset to inherited value" : "Reset to default"} onClick={() => setting.reset()}><Undo2 size={12} /></button>
      ) : null}
      <Switch label={`Use ${label}`} checked={setting.value} disabled={!setting.writable} onChange={setting.set} />
    </span>
  );
}

/** The model providers a runtime's catalog names, as their marks. */
export function TalksTo({ providers }: { providers: readonly string[] }) {
  if (providers.length === 0) return null;
  const shown = providers.slice(0, MAX_MARKS);
  const rest = providers.slice(MAX_MARKS);
  return (
    <span className="runtimes-marks" aria-label="Talks to">
      {shown.map((provider) => <ProviderIconStack key={provider} modelProvider={provider} hint={{ side: "top" }} />)}
      {rest.length ? <small {...tooltipProps(rest.map(providerLabel).join(", "), { side: "top" })}>+{rest.length}</small> : null}
    </span>
  );
}

/** What a runtime's line says: its release, or that it is built in, then its state. */
export function stateParts(row: RuntimeRow): Array<{ text: string; tone?: RuntimeTone | undefined }> {
  return [...(row.state === "built-in" ? [{ text: "Built in" }] : row.version.text ? [{ text: row.version.text }] : []), ...row.status];
}

/** Pi's part of the detail: its default model and thinking, and its expert values folded below. */
function PiTail({ snapshot, onNotify }: { snapshot: HostSnapshot | undefined; onNotify(message: string, level?: "info" | "warning" | "error"): void }) {
  const pi = usePiConfig(snapshot, onNotify);
  return (
    <>
      <SettingsSection title="Default model">
        <PiDefaults pi={pi} snapshot={snapshot} />
      </SettingsSection>
      <PiAdvanced pi={pi} snapshot={snapshot} />
    </>
  );
}

/**
 * One runtime on Settings → Runtimes: its name, state and switches over what
 * its kit draws (the program, the sign-in, a second setup), its models and
 * its default model; Pi's own file folds under Advanced.
 */
export function RuntimeDetail({ backend, row, card, snapshot, onBack, onMakeDefault, onOpenProgram, onNotify }: {
  backend: UiRuntimeBackend;
  row: RuntimeRow;
  /** The card the runtime's kit contributed, when its kit is on. */
  card: SettingsPageContribution | undefined;
  snapshot: HostSnapshot | undefined;
  /** Where the page is narrow: back to the list. */
  onBack?: (() => void) | undefined;
  onMakeDefault(): void;
  /** Scrolls to the program row on the card, where installing and updating happen. */
  onOpenProgram(): void;
  onNotify(message: string, level?: "info" | "warning" | "error"): void;
}) {
  const { readOnly } = useHostCapabilities();
  const enabled = useRuntimeEnabled(backend.kind);
  const [badges, setBadges] = useState<Partial<Record<ProviderCardBadgeSource, ProviderCardBadge>>>({});
  const [addingProvider, setAddingProvider] = useState(false);
  const report = useCallback((source: ProviderCardBadgeSource, badge: ProviderCardBadge | undefined) => {
    setBadges((current) => {
      const held = current[source];
      if (held?.label === badge?.label && held?.tone === badge?.tone) return current;
      const next = { ...current };
      if (badge) next[source] = badge;
      else delete next[source];
      return next;
    });
  }, []);
  const off = !enabled.value;
  const builtIn = row.state === "built-in";
  const action = row.actions[0];
  const starLabel = row.isDefault ? `New threads start on ${backend.label}` : `Start new threads on ${backend.label}`;

  return (
    <section className="runtimes-detail" aria-label={backend.label}>
      <header className="runtimes-detail-head">
        {onBack ? <Button variant="ghost" className="runtimes-back" icon={<ChevronLeft size={14} aria-hidden />} onClick={onBack}>Runtimes</Button> : null}
        <span className="runtimes-detail-mark" aria-hidden><ProviderIconStack runtimeProvider={backend.kind} className="runtimes-detail-icon" hint={false} /></span>
        <div className="runtimes-detail-title">
          <h2>{backend.label}</h2>
          <small {...tooltipProps(row.note, { side: "top" })}>
            {stateParts(row).map((part, index) => <span key={part.text} data-tone={part.tone}>{index ? " · " : ""}{part.text}</span>)}
          </small>
        </div>
        <div className="runtimes-detail-tools">
          <TalksTo providers={row.providers} />
          <div className="runtime-badges">
            {off ? <Badge tone="neutral">{enabled.editing === "project" && enabled.project ? `Off for ${enabled.project.label}` : "Off"}</Badge> : null}
            {SOURCES.map((source) => {
              const badge = badges[source];
              return badge ? <Badge key={source} tone={badge.tone} dot={badge.tone !== "neutral"}>{badge.label}</Badge> : null;
            })}
          </div>
          {action ? (
            <Button variant="default" aria-label={`${action === "install" ? "Install" : "Update"} ${backend.label}`} onClick={onOpenProgram}>{action === "install" ? "Install" : "Update"}</Button>
          ) : null}
          <button
            type="button"
            className="runtimes-star"
            aria-pressed={row.isDefault}
            aria-label={starLabel}
            disabled={row.isDefault || readOnly}
            {...tooltipProps(readOnly && !row.isDefault ? READ_ONLY_REASON : starLabel, { side: "top" })}
            onClick={onMakeDefault}
          ><Star size={15} aria-hidden fill={row.isDefault ? "currentColor" : "none"} /></button>
          <RuntimeEnabledSwitch setting={enabled} label={backend.label} detailed />
        </div>
      </header>

      {/* Off: the kit's rows stay usable, so a runtime can still be set up before a project turns it on. */}
      <div className="runtimes-detail-body" data-off={off ? "" : undefined}>
        {builtIn || card ? (
          <SettingsSection
            title={builtIn ? "Model providers" : "Program and account"}
            headerAction={builtIn ? <Button variant="ghost" icon={<Plus size={14} aria-hidden />} onClick={() => setAddingProvider(true)}>Add custom provider</Button> : undefined}
          >
            {card ? (
              <ProviderCardContext.Provider value={report}>
                <card.Component cwd={snapshot?.cwd} onNotify={onNotify} />
              </ProviderCardContext.Provider>
            ) : <p className="settings-group-note">The extension that lists Pi's providers is off.</p>}
          </SettingsSection>
        ) : null}

        <SettingsSection title="Models" id="runtime-models">
          <RuntimeModels backends={[backend]} />
        </SettingsSection>

        {builtIn ? <PiTail snapshot={snapshot} onNotify={onNotify} /> : (
          <SettingsSection title="Default model">
            <SettingRow
              id={settingAnchor("Default model")}
              title="Default model"
              description="The runtime chooses; a thread picks its own in the composer. Tau sets no default here yet."
              control={<span className="settings-row-empty">Runtime's choice</span>}
            />
          </SettingsSection>
        )}
      </div>
      {addingProvider ? <AddModelProviderModal onClose={() => setAddingProvider(false)} /> : null}
    </section>
  );
}
