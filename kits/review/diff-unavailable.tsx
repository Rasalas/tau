import { ExternalLink } from "lucide-react";

const RATE_LIMITED = /rate.?limit|HTTP 429|too many requests/iu;
const WAIT = /(?:limit resets in about|asks again in) (\d+ (?:seconds?|minutes?))/iu;

/** Why a diff did not load, for a reader who never saw the transport error; the raw text stays in the details. */
export function describeDiffError(error: string, provider: string): { title: string; description: string; limited: boolean } {
  if (RATE_LIMITED.test(error)) {
    const wait = WAIT.exec(error)?.[1];
    return {
      title: `${provider} rate limit reached`,
      description: `${provider} is limiting requests, so the diff could not be loaded. ${wait ? `Try again in about ${wait}` : "Try again after the limit resets"}, or read the changes on ${provider}.`,
      limited: true,
    };
  }
  return { title: "Could not load the diff", description: error, limited: false };
}

/** A failed diff load: the reason, Retry, and the request on its provider's site. */
export function DiffUnavailable({ error, provider, onRetry, onOpen }: { error: string; provider: string; onRetry(): void; onOpen(): void }) {
  const { title, description, limited } = describeDiffError(error, provider);
  return (
    <div className="pr-unavailable" role="alert">
      <strong>{title}</strong>
      <p>{description}</p>
      <div className="pr-actions">
        <button className="mini-button" onClick={onRetry}>Retry</button>
        <button className="text-button" onClick={onOpen}>Open on {provider} <ExternalLink size={10} aria-hidden="true" /></button>
      </div>
      {limited ? <details className="pr-unavailable-details"><summary>Technical details</summary><pre>{error}</pre></details> : null}
    </div>
  );
}
