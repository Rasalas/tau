import type { SettingsPageContribution } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";

/** The element id of a card, for the page to scroll to when a card's own id opened Settings. */
export function providerCardId(pageId: string): string {
  return `provider-card-${pageId}`;
}

/** One card per runtime backend a kit describes, in the host's runtime order. */
export function ProvidersPage({ cards, cwd, onNotify }: { cards: readonly SettingsPageContribution[]; cwd?: string; onNotify(message: string): void }) {
  return (
    <div className="settings-page">
      <p className="lede">The programs that run threads and the providers Pi reaches: whether each is installed and current, who it is signed in as, and signing in or out.</p>
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
    </div>
  );
}
