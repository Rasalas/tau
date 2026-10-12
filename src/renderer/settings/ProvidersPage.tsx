import { useCallback, useState } from "react";
import { Undo2 } from "lucide-react";
import type { UiRuntimeBackend } from "../../shared/contracts";
import type { SettingsPageContribution } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { tooltipProps } from "../components/ui/Tooltip";
import { Badge, Switch } from "./controls";
import { ProviderCardContext, type ProviderCardBadge, type ProviderCardBadgeSource } from "./provider-card-state";
import { RuntimeModels } from "./RuntimeModels";
import { SettingOrigin, SettingsSection, useSetting } from "./settings-layout";

/** The element id of a card, for the page to scroll to when a card's own id opened Settings. */
export function providerCardId(pageId: string): string {
  return `provider-card-${pageId}`;
}

const SOURCES: readonly ProviderCardBadgeSource[] = ["program", "account"];

const readEnabled = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);

/** Why the switch is inert when the level being edited or the pairing cannot hold it. */
function inertReason(setting: { lock?: string | undefined; readOnly?: boolean | undefined }): string {
  return setting.readOnly ? "This device is paired Read only: it can see settings, not change them." : setting.lock ?? "This setting cannot be changed here.";
}

/** One runtime's card: its mark, its name and the state its rows report, over the rows the kit draws. */
function ProviderCard({ card, cwd, onNotify }: { card: SettingsPageContribution; cwd: string | undefined; onNotify(message: string, level?: "info" | "warning" | "error"): void }) {
  const [badges, setBadges] = useState<Partial<Record<ProviderCardBadgeSource, ProviderCardBadge>>>({});
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
  // The kit stays active either way; the switch decides whether the host starts work on the runtime (ADR 0033).
  const enabled = useSetting<boolean>(`runtimeEnabled.${card.runtime ?? card.id}`, { defaultValue: true, scope: "both", read: readEnabled });
  const off = !enabled.value;
  const resettable = enabled.writable && enabled.origin === enabled.editing;
  return (
    <section id={providerCardId(card.id)} className="settings-section provider-card" aria-label={card.label} data-off={off ? "" : undefined}>
      <div className="settings-section-head provider-card-head">
        <h2>
          <span className="provider-card-mark" aria-hidden><ProviderIconStack runtimeProvider={card.runtime} className="provider-card-icon" hint={false} /></span>
          <span>{card.label}</span>
        </h2>
        <div className="provider-card-tools">
          <div className="provider-card-badges">
            {off ? <Badge tone="neutral">{enabled.editing === "project" && enabled.project ? `Off for ${enabled.project.label}` : "Off"}</Badge> : null}
            {SOURCES.map((source) => {
              const badge = badges[source];
              return badge ? <Badge key={source} tone={badge.tone} dot={badge.tone !== "neutral"}>{badge.label}</Badge> : null;
            })}
          </div>
          <span className="provider-card-switch" {...tooltipProps(enabled.writable ? undefined : inertReason(enabled), { side: "top" })}>
            <SettingOrigin setting={enabled} />
            {resettable ? (
              <button type="button" className="setting-reset" aria-label={`Reset ${card.label} to ${enabled.editing === "project" ? "inherited value" : "default"}`} title={enabled.editing === "project" ? "Reset to inherited value" : "Reset to default"} onClick={() => enabled.reset()}><Undo2 size={12} /></button>
            ) : null}
            <Switch label={`Use ${card.label}`} checked={enabled.value} disabled={!enabled.writable} onChange={enabled.set} />
          </span>
        </div>
      </div>
      <div className="settings-group">
        <ProviderCardContext.Provider value={report}>
          <card.Component cwd={cwd} onNotify={onNotify} />
        </ProviderCardContext.Provider>
      </div>
    </section>
  );
}

/** One card per runtime backend a kit describes, in the host's runtime order, then every runtime's models. */
export function ProvidersPage({ cards, backends = [], cwd, onNotify }: { cards: readonly SettingsPageContribution[]; backends?: readonly UiRuntimeBackend[]; cwd?: string; onNotify(message: string, level?: "info" | "warning" | "error"): void }) {
  return (
    <div className="settings-page providers-page">
      {cards.map((card) => <ProviderCard key={card.id} card={card} cwd={cwd} onNotify={onNotify} />)}
      {backends.length ? (
        <SettingsSection title="Models" id="runtime-models">
          <RuntimeModels backends={backends} />
        </SettingsSection>
      ) : null}
    </div>
  );
}
