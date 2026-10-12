import { Component, useState, type ReactNode } from "react";
import { chunkRecovery, type ChunkRecovery } from "../chunk-reload";
import { getPlatform } from "../platform-context";

/** What a render error took down: the whole window, or the conversation beside the sidebar. */
export type RenderErrorScope = "window" | "conversation";

export interface RenderErrorBoundaryProps {
  scope: RenderErrorScope;
  /** A new value (the open thread) clears a failure that belonged to the old one. */
  resetKey?: string;
  recovery?: ChunkRecovery;
  children: ReactNode;
}

interface Failure {
  error: unknown;
  componentStack?: string | undefined;
}

interface RenderErrorBoundaryState {
  failure?: Failure | undefined;
  key?: string | undefined;
}

/**
 * Catches what no feature boundary does: a render error in the shell, the header, the transcript
 * or the composer. Without it React unmounts the tree and leaves a blank window.
 */
export class RenderErrorBoundary extends Component<RenderErrorBoundaryProps, RenderErrorBoundaryState> {
  state: RenderErrorBoundaryState = { key: this.props.resetKey };

  static getDerivedStateFromProps(props: RenderErrorBoundaryProps, state: RenderErrorBoundaryState): RenderErrorBoundaryState | null {
    return props.resetKey === state.key ? null : { key: props.resetKey, failure: undefined };
  }

  static getDerivedStateFromError(error: unknown): RenderErrorBoundaryState {
    return { failure: { error } };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error(`[tau] ${this.props.scope} failed to render`, error);
    this.setState((state) => state.failure?.error === error ? { failure: { error, componentStack: info.componentStack ?? undefined } } : null);
  }

  render() {
    const { failure } = this.state;
    if (!failure) return this.props.children;
    const { scope } = this.props;
    const card = <RenderErrorCard
      scope={scope}
      failure={failure}
      recovery={this.props.recovery ?? chunkRecovery}
      onRetry={() => this.setState({ failure: undefined })}
    />;
    return scope === "window"
      ? <div className="lazy-feature-screen render-error-frame">{card}</div>
      : <main className="conversation-column conversation-failed render-error-frame">{card}</main>;
  }
}

function RenderErrorCard({ scope, failure, recovery, onRetry }: {
  scope: RenderErrorScope;
  failure: Failure;
  recovery: ChunkRecovery;
  onRetry(): void;
}) {
  const [copied, setCopied] = useState<"copied" | "failed">();
  const copy = () => {
    getPlatform().clipboard.writeText(errorReport(scope, failure)).then(() => setCopied("copied"), () => setCopied("failed"));
  };
  return <div className="lazy-feature-error render-error" role="alert">
    <strong>Something went wrong.</strong>
    <p>{scope === "window" ? "Tau could not draw this window." : "This conversation could not be drawn. You can still pick another thread."}</p>
    <div className="lazy-feature-actions">
      <button type="button" className="primary" onClick={onRetry}>Try again</button>
      <button type="button" onClick={() => recovery.reload()}>Reload</button>
      <button type="button" onClick={copy}>{copied === "copied" ? "Copied" : copied === "failed" ? "Copy failed" : "Copy error"}</button>
    </div>
    <details>
      <summary>Details</summary>
      <pre>{errorText(failure.error)}</pre>
    </details>
  </div>;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.stack ?? (error.message || String(error));
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error, null, 2) ?? String(error);
  } catch {
    return String(error);
  }
}

const MAX_CAUSE_DEPTH = 5;

/** For a bug report. The address is left out: a remote window carries its token in the query. */
function errorReport(scope: RenderErrorScope, { error, componentStack }: Failure): string {
  const lines = [`Tau render error (${scope})`, `Time: ${new Date().toISOString()}`, `Client: ${globalThis.navigator?.userAgent ?? "unknown"}`, "", errorText(error)];
  if (componentStack?.trim()) lines.push("", "Component stack:", componentStack.trim());
  let cause = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; cause !== undefined && depth < MAX_CAUSE_DEPTH; depth += 1) {
    lines.push("", "Caused by:", errorText(cause));
    cause = cause instanceof Error ? cause.cause : undefined;
  }
  return lines.join("\n");
}
