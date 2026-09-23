import { CircleAlert } from "lucide-react";
import { useThreadShell } from "../use-thread-shell";

/** A thread whose runtime did not start: why, and the two ways out. The thread stays readable below. */
export function ThreadRuntimeBanner({ sessionId, onRetry, onOpenProviders }: {
  sessionId: string;
  onRetry(path: string): void;
  onOpenProviders(): void;
}) {
  const shell = useThreadShell(sessionId);
  if (!shell?.runtimeError) return null;
  return <div className="thread-runtime-banner" role="alert">
    <CircleAlert size={15} aria-hidden="true" />
    <div>
      <strong>This thread's runtime did not start</strong>
      <p>{shell.runtimeError}</p>
      <span>The thread is read-only until it starts.</span>
    </div>
    <button type="button" className="mini-button" onClick={() => onRetry(shell.path)}>Try again</button>
    <button type="button" className="mini-button" onClick={onOpenProviders}>Providers</button>
  </div>;
}
