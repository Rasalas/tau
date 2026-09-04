import { Component, type ReactNode } from "react";

export interface LazyFeatureBoundaryProps {
  label: string;
  extensionId?: string;
  extensionName?: string;
  registry?: { deactivate(id: string): void };
  onNotify?: (message: string) => void;
  onError?: (error: Error) => void;
  children: ReactNode;
}

/**
 * A failed dynamic import or extension render error is recoverable.
 * Keep the failure in the feature slot, deactivate the crashing extension if known,
 * and offer a repeatable reload/retry rather than taking down the workbench shell.
 */
export class LazyFeatureBoundary extends Component<
  LazyFeatureBoundaryProps,
  { error?: Error }
> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  componentDidCatch(error: Error) {
    if (this.props.extensionId && this.props.registry) {
      try {
        this.props.registry.deactivate(this.props.extensionId);
        const name = this.props.extensionName || this.props.extensionId;
        this.props.onNotify?.(`Extension ${name} was deactivated due to render error: ${error.message}`);
      } catch {
        // Safe fallback
      }
    }
    this.props.onError?.(error);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="lazy-feature-error" role="alert">
          <strong>Could not load {this.props.label}.</strong>
          <span>The feature chunk may be out of date or failed to render.</span>
          <button onClick={() => this.setState({ error: undefined })}>Retry</button>
        </div>
      );
    }
    return this.props.children;
  }
}

export function LazyFeatureFallback({ label }: { label: string }) {
  return <div className="lazy-feature-loading" role="status">Loading {label}…</div>;
}
