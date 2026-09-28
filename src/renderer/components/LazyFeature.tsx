import { Component, createElement, lazy, type ComponentProps, type ComponentType, type ReactNode } from "react";
import { chunkRecovery, isChunkLoadError, type ChunkRecovery } from "../chunk-reload";

export interface LazyFeatureBoundaryProps {
  label: string;
  /** The card's first line; `Could not load <label>.` when left out. */
  title?: string;
  extensionId?: string;
  extensionName?: string;
  registry?: { deactivate(id: string): void };
  onNotify?: (message: string) => void;
  onError?: (error: Error) => void;
  /** Leaves the feature, where it covers the window (a page, Settings, an overlay). */
  onClose?: () => void;
  /** The container the feature draws itself in, so the card takes its place rather than the next free cell. */
  frame?: (content: ReactNode) => ReactNode;
  recovery?: ChunkRecovery;
  children: ReactNode;
}

interface LazyFeatureBoundaryState {
  error?: Error;
  /** The error was a chunk that is gone, not code that failed. */
  stale?: boolean;
}

/**
 * A failed dynamic import or extension render error is recoverable.
 * A missing chunk reloads the page once; a render error deactivates the
 * extension, if known. Either way the card stays in the feature's slot.
 */
export class LazyFeatureBoundary extends Component<LazyFeatureBoundaryProps, LazyFeatureBoundaryState> {
  state: LazyFeatureBoundaryState = {};

  static getDerivedStateFromError(error: Error): LazyFeatureBoundaryState {
    return { error, stale: isChunkLoadError(error) };
  }

  private get recovery(): ChunkRecovery {
    return this.props.recovery ?? chunkRecovery;
  }

  componentDidCatch(error: Error) {
    console.error(`[tau] ${this.props.label} failed to load`, error);
    // A page on its way out; what failed is the stale build, not the extension.
    if (this.recovery.reloading()) return;
    if (isChunkLoadError(error)) {
      if (this.recovery.reloadOnce()) this.forceUpdate();
      this.props.onError?.(error);
      return;
    }
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
    const { error, stale } = this.state;
    if (!error) return this.props.children;
    const frame = this.props.frame ?? ((content: ReactNode) => content);
    if (this.recovery.reloading()) return frame(<LazyFeatureFallback label="the new version" />);
    const retry = () => {
      retryFailedImports();
      this.setState({ error: undefined, stale: undefined });
    };
    const close = this.props.onClose;
    return frame(
      <div className="lazy-feature-error" role="alert">
        <strong>{stale ? "Tau was updated. Reload to continue." : this.props.title ?? `Could not load ${this.props.label}.`}</strong>
        <div className="lazy-feature-actions">
          {stale ? <button type="button" className="primary" onClick={() => this.recovery.reload()}>Reload window</button> : null}
          {/* A browser keeps a failed module fetch for the page's life; only a reload fetches it again. */}
          {stale ? null : <button type="button" onClick={retry}>Retry</button>}
          {close ? <button type="button" onClick={close}>Close</button> : null}
        </div>
        <details>
          <summary>Details</summary>
          <pre>{error.message || String(error)}</pre>
        </details>
      </div>,
    );
  }
}

export function LazyFeatureFallback({ label }: { label: string }) {
  return <div className="lazy-feature-loading" role="status">Loading {label}…</div>;
}

/** Resets of imports that failed, run by the next Retry. */
const failedImports = new Set<() => void>();

/** A lazy import failed; `reset` gives it a fresh `lazy` when the user retries. */
export function markImportFailed(reset: () => void): void {
  failedImports.add(reset);
}

/** Swapped here rather than on rejection: a fresh `lazy` there would load again before the error ever showed. */
export function retryFailedImports(): void {
  const resets = [...failedImports];
  failedImports.clear();
  for (const reset of resets) reset();
}

/** `React.lazy` keeps a rejected import for good; this one imports again on Retry. */
export function retryableLazy<T extends ComponentType<any>>(load: () => Promise<{ default: T }>): ComponentType<ComponentProps<T>> {
  const make = () => lazy(() => load().catch((error: unknown) => {
    markImportFailed(() => { current = make(); });
    throw error;
  }));
  let current = make();
  function RetryableLazy(props: ComponentProps<T>) {
    return createElement(current, props);
  }
  return RetryableLazy;
}
