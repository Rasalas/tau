import { useEffect, useState, type ReactNode } from "react";
import { Clock, RotateCcw, TriangleAlert } from "lucide-react";
import type { UiThreadLimit } from "../../shared/contracts";
import { useHostClient } from "../host-client-context";
import { errorMessage } from "../../workbench/error-message";
import { noticeHeadline } from "./notice-text";
import { providerLabel } from "./ProviderIconStack";
// Loaded with the bar: a failed turn is rare, so its styles stay out of the first paint.
import "./ComposerNotice.css";

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

export interface ComposerNoticeProps {
  sessionId: string;
  limit?: UiThreadLimit | undefined;
  /** The failed turn's error, as the host recorded it. */
  error?: string | undefined;
  /** The thread's model provider, to name who refused. */
  provider?: string | undefined;
  onRetry?: (() => void) | undefined;
  onSwitchModel?: (() => void) | undefined;
  onReplaceKey(): void;
}

/** "OpenAI rate limit", or plain "Rate limit" when the thread names no provider. */
const rateLimit = (provider?: string) => provider ? `${providerLabel(provider)} rate limit` : "Rate limit";

function Bar({ tone, icon, title, text, children }: { tone: "fail" | "warn"; icon: ReactNode; title: string; text: ReactNode; children: ReactNode }) {
  return (
    <div className={`composer-notice ${tone}`} role="status">
      <strong>{icon}{title}</strong>
      <p>{text}</p>
      <div className="composer-notice-actions">{children}</div>
    </div>
  );
}

/**
 * Why the thread stopped, as a bar on top of the composer (design 2c): a failed
 * turn, a key the provider refused, a rate limit, or a usage limit with its reset.
 */
export function ComposerNotice(props: ComposerNoticeProps) {
  return props.limit ? <LimitBar {...props} limit={props.limit} /> : <ErrorBar {...props} />;
}

function SwitchModel({ onSwitchModel }: Pick<ComposerNoticeProps, "onSwitchModel">) {
  return onSwitchModel ? <button type="button" onClick={onSwitchModel}>Switch model</button> : null;
}

function ErrorBar({ error = "", provider, onRetry, onSwitchModel, onReplaceKey }: ComposerNoticeProps) {
  const text = noticeHeadline(error);
  const status = /^\d{3}/u.exec(text)?.[0];
  const who = provider ? providerLabel(provider) : "The provider";
  const retry = onRetry ? <button type="button" className="primary" onClick={onRetry}><RotateCcw size={12} aria-hidden="true" />Retry</button> : null;
  const alert = <TriangleAlert size={12} aria-hidden="true" />;
  const detail = <span title={text === error.trim() ? undefined : error}>{text}</span>;
  if (status === "401" || status === "403" || /api.?key|unauthori[sz]ed/iu.test(text)) {
    return <Bar tone="fail" icon={alert} title={`${who} rejected the API key`} text={detail}>
      <SwitchModel onSwitchModel={onSwitchModel} />
      <button type="button" className="primary" onClick={onReplaceKey}>Replace key</button>
    </Bar>;
  }
  if (status === "429" || /rate.?limit|too many requests/iu.test(text)) {
    return <Bar tone="warn" icon={<Clock size={12} aria-hidden="true" />} title={rateLimit(provider)} text={detail}>
      <SwitchModel onSwitchModel={onSwitchModel} />{retry}
    </Bar>;
  }
  return <Bar tone="fail" icon={alert} title="Stopped with an error" text={detail}>{retry}</Bar>;
}

/** A provider's usage limit: when it resets, and whether to wait for it or continue now. */
function LimitBar({ sessionId, limit, provider, onSwitchModel }: ComposerNoticeProps & { limit: UiThreadLimit }) {
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
  const future = limit.resetsAt !== undefined && limit.resetsAt > now;
  const when = limit.resumeAt !== undefined ? ` · continues at ${clock(limit.resumeAt)}`
    : future ? ` · resets in ${formatWait(limit.resetsAt! - now)}` : "";
  return <Bar tone="warn" icon={<Clock size={12} aria-hidden="true" />} title={`${rateLimit(provider)}${when}`}
    text={<><span title={limit.message}>{noticeHeadline(limit.message)}</span>{problem ? <em>{problem}</em> : null}</>}>
    <SwitchModel onSwitchModel={onSwitchModel} />
    <button type="button" disabled={busy} onClick={() => resume("now")}>Resume now</button>
    {limit.resumeAt !== undefined
      ? <button type="button" className="secondary" disabled={busy} onClick={() => resume("cancel")}>Don’t wait</button>
      : future ? <button type="button" className="secondary" disabled={busy} onClick={() => resume("reset")}>Wait</button> : null}
  </Bar>;
}
