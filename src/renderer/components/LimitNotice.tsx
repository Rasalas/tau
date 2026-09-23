import { useEffect, useState } from "react";
import { Hourglass } from "lucide-react";
import type { UiThreadLimit } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { errorMessage } from "../../workbench/error-message";

/** "2 h 5 min", "12 min", "under a minute": a wait reads the same in every timezone. */
export function formatWait(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  if (minutes <= 1) return "under a minute";
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min`;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

function clock(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/**
 * A thread its provider stopped at a usage or rate limit, at the end of the
 * conversation where a failed turn says why. It names the reset when the
 * provider did and offers to continue then, by itself, or now.
 */
export function LimitNotice({ sessionId, limit }: { sessionId: string; limit: UiThreadLimit }) {
  const client = useHostClient();
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string>();
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const resume = (when: "now" | "reset" | "cancel") => {
    if (!client) return;
    setBusy(true);
    setProblem(undefined);
    client.resumeLimited(sessionId, when)
      .catch((error: unknown) => setProblem(errorMessage(error)))
      .finally(() => setBusy(false));
  };
  const reset = limit.resetsAt !== undefined && limit.resetsAt > now
    ? `Resets at ${clock(limit.resetsAt)}, in ${formatWait(limit.resetsAt - now)}.`
    : limit.resetsAt !== undefined ? "The limit should have reset by now." : "The provider did not say when it resets.";
  return (
    <div className="limit-notice" role="status">
      <Hourglass size={14} aria-hidden="true" />
      <div className="limit-notice-body">
        <strong>Usage limit reached</strong>
        <span>{limit.resumeAt !== undefined ? `Continues by itself at ${clock(limit.resumeAt)}.` : reset}</span>
        <small title={limit.message}>{limit.message}</small>
        {problem ? <small className="limit-notice-problem">{problem}</small> : null}
      </div>
      <div className="limit-notice-actions">
        {limit.resumeAt !== undefined
          ? <button type="button" className="mini-button" disabled={busy} onClick={() => resume("cancel")}>Cancel</button>
          : limit.resetsAt !== undefined && limit.resetsAt > now
            ? <button type="button" className="mini-button" disabled={busy} onClick={() => resume("reset")}>Resume at reset</button>
            : null}
        <button type="button" className="mini-button" disabled={busy} onClick={() => resume("now")}>Resume now</button>
      </div>
    </div>
  );
}
