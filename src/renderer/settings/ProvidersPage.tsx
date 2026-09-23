import type { UiRuntimeBackend } from "../../shared/contracts";
import type { SettingsPageContribution } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";
import { RuntimeModels } from "./RuntimeModels";
import { SettingsSection } from "./settings-layout";

/** The element id of a card, for the page to scroll to when a card's own id opened Settings. */
export function providerCardId(pageId: string): string {
  return `provider-card-${pageId}`;
}

/** One card per runtime backend a kit describes, in the host's runtime order, then every runtime's models. */
export function ProvidersPage({ cards, backends = [], cwd, onNotify }: { cards: readonly SettingsPageContribution[]; backends?: readonly UiRuntimeBackend[]; cwd?: string; onNotify(message: string): void }) {
  return (
    <div className="settings-page">
      <p className="lede">The programs that run threads besides Pi: whether each is installed and current, who it is signed in as, and where Tau finds it.</p>
      {cards.map((card) => (
        <section key={card.id} id={providerCardId(card.id)} className="provider-card" aria-label={card.label}>
          <header>
            <ProviderIconStack runtimeProvider={card.runtime} className="provider-card-icon" />
            <strong>{card.label}</strong>
          </header>
          <div className="provider-card-body">
            <card.Component cwd={cwd} onNotify={onNotify} />
          </div>
        </section>
      ))}
      {backends.length ? (
        <SettingsSection title="Models" id="runtime-models">
          <RuntimeModels backends={backends} />
        </SettingsSection>
      ) : null}
    </div>
  );
}
