import { MAX_WEBHOOK_WAIT_SECONDS, MIN_WEBHOOK_WAIT_SECONDS } from "./webhook-coalescing.js";
import { MAX_WEBHOOK_PATH, validWebhookPath } from "./webhook-path.js";

export interface WebhookBurstDraft { enabled: boolean; keyPath: string; waitSeconds: number }
export default function WebhookBurstsEditor({ value, disabled, onChange }: { value: WebhookBurstDraft; disabled: boolean; onChange(value: WebhookBurstDraft): void }) {
  const invalidPath = Boolean(value.keyPath) && !validWebhookPath(value.keyPath, false);
  return <fieldset className="scheduling-filters" disabled={disabled}>
    <legend>Bursts</legend>
    <label>Deliveries<select value={value.enabled ? "combine" : "each"} onChange={(event) => onChange({ ...value, enabled: event.target.value === "combine" })}><option value="each">Start a run for every delivery</option><option value="combine">Combine deliveries with the same key</option></select></label>
    {value.enabled ? <>
      <label>Key path<input required maxLength={MAX_WEBHOOK_PATH} value={value.keyPath} placeholder="pull_request.number" spellCheck={false} aria-invalid={invalidPath || undefined} onChange={(event) => onChange({ ...value, keyPath: event.target.value })} /></label>
      {invalidPath ? <small className="scheduling-error">Key path must use dot-separated names or array indices, without [].</small> : null}
      <label>Wait in seconds<input type="number" required min={MIN_WEBHOOK_WAIT_SECONDS} max={MAX_WEBHOOK_WAIT_SECONDS} step={1} value={value.waitSeconds} onChange={(event) => onChange({ ...value, waitSeconds: Number(event.target.value) })} /></label>
      <p>The first delivery opens the wait. When it ends, one run starts with the latest payload. Later deliveries don't extend it. A delivery without the key path starts its own run.</p>
    </> : null}
  </fieldset>;
}
