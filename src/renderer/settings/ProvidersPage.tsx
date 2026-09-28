import { useCallback, useState } from "react";
import type { UiRuntimeBackend } from "../../shared/contracts";
import type { SettingsPageContribution } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { Badge } from "./controls";
import { ProviderCardContext, type ProviderCardBadge, type ProviderCardBadgeSource } from "./provider-card-state";
import { RuntimeModels } from "./RuntimeModels";
import { SettingsSection } from "./settings-layout";

/** The element id of a card, for the page to scroll to when a card's own id opened Settings. */
export function providerCardId(pageId: string): string {
  return `provider-card-${pageId}`;
}

const SOURCES: readonly ProviderCardBadgeSource[] = ["program", "account"];

/** One runtime's card: its mark, its name and the state its rows report, over the rows the kit draws. */
function ProviderCard({ card, cwd, onNotify }: { card: SettingsPageContribution; cwd: string | undefined; onNotify(message: string): void }) {
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
  return (
    <section id={providerCardId(card.id)} className="settings-section provider-card" aria-label={card.label}>
      <div className="settings-section-head provider-card-head">
        <h2>
          <span className="provider-card-mark" aria-hidden><ProviderIconStack runtimeProvider={card.runtime} className="provider-card-icon" hint={false} /></span>
          <span>{card.label}</span>
        </h2>
        <div className="provider-card-badges">
          {SOURCES.map((source) => {
            const badge = badges[source];
            return badge ? <Badge key={source} tone={badge.tone} dot={badge.tone !== "neutral"}>{badge.label}</Badge> : null;
          })}
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
export function ProvidersPage({ cards, backends = [], cwd, onNotify }: { cards: readonly SettingsPageContribution[]; backends?: readonly UiRuntimeBackend[]; cwd?: string; onNotify(message: string): void }) {
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
