import { ExternalLink, ShieldAlert } from "lucide-react";
import { usePreferences, type ComposerGateProps } from "tau";
import { acknowledge, subscriptionLoginWarning } from "./policy.js";

/**
 * Asked once per provider before a model behind a subscription login Pi
 * performs is chosen or sent to. It never blocks for good: the choice stays the user's.
 */
export function SubscriptionLoginPrompt({ context, proceed, cancel }: ComposerGateProps) {
  const preferences = usePreferences();
  const provider = context.model?.provider ?? "";
  const warning = subscriptionLoginWarning(provider);
  return (
    <section className="subscription-login-prompt" role="dialog" aria-modal="true" aria-label={warning.title}>
      <header><ShieldAlert size={15} /><strong>{warning.title}</strong></header>
      <p>{warning.message}</p>
      {warning.source ? <a href={warning.source} target="_blank" rel="noreferrer">What the vendor says <ExternalLink size={11} /></a> : null}
      <footer>
        <button autoFocus onClick={cancel}>Pick another model</button>
        <button className="primary" onClick={() => { acknowledge(preferences, provider); proceed(); }}>Use it anyway</button>
      </footer>
    </section>
  );
}
