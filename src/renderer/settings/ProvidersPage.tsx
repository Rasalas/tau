import type { SettingsPageContribution } from "../extension-system";
import { ProviderIconStack } from "../components/ProviderIconStack";

/** One card per runtime backend a kit describes, in the order the kits gave. */
export function ProvidersPage({ cards, cwd, onNotify }: { cards: readonly SettingsPageContribution[]; cwd?: string; onNotify(message: string): void }) {
  return (
    <div className="settings-page">
      <p className="lede">The programs that run threads besides Pi: whether each is installed and current, who it is signed in as, and where Tau finds it.</p>
      {cards.map((card) => (
        <section key={card.id} className="provider-card" aria-label={card.label}>
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
