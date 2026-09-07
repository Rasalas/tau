import { ExternalLink, ShieldAlert } from "lucide-react";
import { subscriptionLoginWarning } from "../../shared/subscription-login";

/**
 * Asked once per provider before a model behind a subscription login Pi
 * performs is used. It never blocks for good: the choice stays the user's.
 */
export function SubscriptionLoginPrompt({ provider, onAccept, onDecline }: {
  provider: string;
  onAccept(): void;
  onDecline(): void;
}) {
  const warning = subscriptionLoginWarning(provider);
  return (
    <div className="palette-backdrop" onMouseDown={onDecline}>
      <section
        className="subscription-login-prompt"
        role="dialog"
        aria-modal="true"
        aria-label={warning.title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header><ShieldAlert size={15} /><strong>{warning.title}</strong></header>
        <p>{warning.message}</p>
        {warning.source ? <a href={warning.source} target="_blank" rel="noreferrer">What the vendor says <ExternalLink size={11} /></a> : null}
        <footer>
          <button autoFocus onClick={onDecline}>Pick another model</button>
          <button className="primary" onClick={onAccept}>Use it anyway</button>
        </footer>
      </section>
    </div>
  );
}
