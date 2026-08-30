import { Component, type ReactNode } from "react";

/**
 * A failed dynamic import is recoverable (for example after a deploy replaced
 * an old chunk). Keep the failure in the feature slot and offer a repeatable
 * reload rather than taking down the workbench shell.
 */
export class LazyFeatureBoundary extends Component<
  { label: string; children: ReactNode },
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="lazy-feature-error" role="alert">
          <strong>Could not load {this.props.label}.</strong>
          <span>The feature chunk may be out of date.</span>
          <button onClick={() => window.location.reload()}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function LazyFeatureFallback({ label }: { label: string }) {
  return <div className="lazy-feature-loading" role="status">Loading {label}…</div>;
}
