import { useId, useState } from "react";
import { validWebhookPath, WEBHOOK_PATH_PROBLEM } from "./webhook-path.js";
import type { WebhookFilter } from "./protocol.js";
import { matchesWebhookFilters, decodeWebhookFilters, MAX_WEBHOOK_FILTER_PATH, MAX_WEBHOOK_FILTER_VALUE, MAX_WEBHOOK_FILTERS } from "./webhook-filters.js";

export interface WebhookFilterDraft {
  path: string;
  op: WebhookFilter["op"];
  type: "string" | "number" | "boolean" | "null";
  value: string;
}

export function webhookFilterDrafts(filters: readonly WebhookFilter[] = []): WebhookFilterDraft[] {
  return filters.map((filter) => ({ path: filter.path, op: filter.op, type: filter.op === "exists" ? "string" : filter.value === null ? "null" : typeof filter.value as WebhookFilterDraft["type"], value: filter.op === "exists" ? "" : filter.value === null ? "" : String(filter.value) }));
}

export function filtersFromDrafts(drafts: readonly WebhookFilterDraft[]): WebhookFilter[] {
  return decodeWebhookFilters(drafts.map((draft) => {
    if (draft.op === "exists") return { path: draft.path, op: draft.op };
    const value = draft.type === "null" ? null : draft.type === "boolean" ? draft.value === "true" : draft.type === "number" ? (draft.value.trim() ? Number(draft.value) : NaN) : draft.value;
    return { path: draft.path, op: draft.op, value };
  }));
}

export default function WebhookFilterEditor({ filters, disabled, onChange }: { filters: readonly WebhookFilterDraft[]; disabled: boolean; onChange(filters: WebhookFilterDraft[]): void }) {
  const [sample, setSample] = useState("");
  const id = useId();
  let results: boolean[] | undefined;
  let sampleError: string | undefined;
  if (sample) {
    let payload: unknown;
    try { payload = JSON.parse(sample); } catch { sampleError = "Not valid JSON."; }
    if (!sampleError) {
      try { results = filtersFromDrafts(filters).map((filter) => matchesWebhookFilters([filter], payload)); }
      catch { sampleError = "Complete the payload filters first."; }
      // Evaluate all rules together as well, including the shared traversal budget.
      if (results?.every(Boolean) && !matchesWebhookFilters(filtersFromDrafts(filters), payload)) results = results.map(() => false);
    }
  }
  const change = (index: number, patch: Partial<WebhookFilterDraft>) => onChange(filters.map((filter, at) => at === index ? { ...filter, ...patch } : filter));
  return <fieldset className="scheduling-filters" disabled={disabled}>
    <legend>Payload filters</legend>
    <p>Optional. Every rule must match. Paths start in the JSON payload, such as action or pull_request.labels[].name. [] checks every item of a list: Equals matches when any item does, Exists when the list has items. Equality checks the value and its type.</p>
    {filters.map((filter, index) => <div className="scheduling-filter" key={index}>
      <label>Payload path {index + 1}<input required maxLength={MAX_WEBHOOK_FILTER_PATH} value={filter.path} placeholder="action" spellCheck={false} aria-invalid={Boolean(filter.path) && !validWebhookPath(filter.path) || undefined} aria-describedby={Boolean(filter.path) && !validWebhookPath(filter.path) ? `${id}-${index}` : undefined} onChange={(event) => change(index, { path: event.target.value })} /></label>
      {filter.path && !validWebhookPath(filter.path) ? <small id={`${id}-${index}`} className="scheduling-error">{WEBHOOK_PATH_PROBLEM}</small> : null}
      <label>Condition {index + 1}<select value={filter.op} onChange={(event) => change(index, { op: event.target.value as WebhookFilterDraft["op"] })}><option value="equals">Equals</option><option value="exists">Exists</option></select></label>
      {filter.op === "equals" ? <>
        <label>Value type {index + 1}<select value={filter.type} onChange={(event) => change(index, { type: event.target.value as WebhookFilterDraft["type"], value: event.target.value === "boolean" ? "true" : "" })}><option value="string">Text</option><option value="number">Number</option><option value="boolean">Boolean</option><option value="null">Null</option></select></label>
        {filter.type === "null" ? null : <label>Expected value {index + 1}{filter.type === "boolean" ? <select value={filter.value} onChange={(event) => change(index, { value: event.target.value })}><option value="true">true</option><option value="false">false</option></select> : <input type={filter.type === "number" ? "number" : "text"} required={filter.type === "number"} step={filter.type === "number" ? "any" : undefined} maxLength={MAX_WEBHOOK_FILTER_VALUE} value={filter.value} onChange={(event) => change(index, { value: event.target.value })} />}</label>}
      </> : null}
      <button type="button" aria-label={`Remove filter ${index + 1}`} onClick={() => onChange(filters.filter((_, at) => at !== index))}>Remove</button>
    </div>)}
    <button type="button" disabled={disabled || filters.length >= MAX_WEBHOOK_FILTERS} onClick={() => onChange([...filters, { path: "", op: "equals", type: "string", value: "" }])}>Add payload filter</button>
    <details className="scheduling-sample"><summary>Check against a sample payload</summary>
      <label>Sample JSON (not saved)<textarea value={sample} maxLength={65_536} rows={5} spellCheck={false} onChange={(event) => setSample(event.target.value)} /></label>
      {sampleError ? <p>{sampleError}</p> : results ? <><ul>{results.map((match, index) => <li key={index}>Rule {index + 1}: {match ? "Matches" : "Doesn't match"}</li>)}</ul><p>{results.every(Boolean) ? "This delivery would start a run." : "This delivery would be ignored."}</p></> : null}
    </details>
    <small>Up to {MAX_WEBHOOK_FILTERS} rules. Nonmatching or invalid JSON deliveries are ignored. With no rules, any signed body can trigger a run.</small>
  </fieldset>;
}
