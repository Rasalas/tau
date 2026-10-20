import type { ReactNode } from "react";

/**
 * A read that failed: what did not load, in plain words, Retry, and the
 * error itself folded under Details for whoever reports it. The look is the
 * render error card's (`lazy-feature-error`), so every failure reads alike.
 */
export function LoadError({ title, description, error, onRetry, children }: {
  title: string;
  /** A line the reader can act on; the raw error never goes here. */
  description?: ReactNode;
  /** The error as it came, shown only when Details is opened. */
  error?: string | undefined;
  onRetry?: (() => void) | undefined;
  /** Further actions after Retry (Close). */
  children?: ReactNode;
}) {
  return <div className="lazy-feature-error load-error" role="alert">
    <strong>{title}</strong>
    {description ? <p>{description}</p> : null}
    {onRetry || children ? <div className="lazy-feature-actions">
      {onRetry ? <button type="button" className="primary" onClick={onRetry}>Retry</button> : null}
      {children}
    </div> : null}
    {error ? <details>
      <summary>Details</summary>
      <pre>{error}</pre>
    </details> : null}
  </div>;
}
