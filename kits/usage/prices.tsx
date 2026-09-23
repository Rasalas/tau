import { useMemo, useState } from "react";
import { useSetting } from "tau";

/** US dollars per million tokens, as `modelPrices` in Tau's config keeps them. */
export interface ModelPrice {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

const FIELDS = ["input", "output", "cacheRead", "cacheWrite"] as const;
type Field = (typeof FIELDS)[number];
const FIELD_LABELS: Record<Field, string> = { input: "Input", output: "Output", cacheRead: "Cache read", cacheWrite: "Cache write" };

type Draft = Partial<Record<Field, string>>;

function rate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** The entries of `modelPrices` that are prices; anything else in the file is left alone. */
export function readPrices(raw: unknown): Record<string, ModelPrice> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const result: Record<string, ModelPrice> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value && typeof value === "object" ? value as Record<string, unknown> : undefined;
    const input = rate(entry?.input);
    const output = rate(entry?.output);
    if (input === undefined || output === undefined) continue;
    const cacheRead = rate(entry?.cacheRead);
    const cacheWrite = rate(entry?.cacheWrite);
    result[key] = { input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) };
  }
  return result;
}

/** A draft as a price, or why it is not one. Blank cache rates are the input rate. */
export function priceFromDraft(draft: Draft, base?: ModelPrice): ModelPrice | string {
  const value = (field: Field): number | undefined | "invalid" => {
    const text = draft[field] ?? (base?.[field] === undefined ? "" : String(base[field]));
    if (text.trim() === "") return undefined;
    const number = Number(text);
    return Number.isFinite(number) && number >= 0 ? number : "invalid";
  };
  const values = Object.fromEntries(FIELDS.map((field) => [field, value(field)])) as Record<Field, number | undefined | "invalid">;
  const wrong = FIELDS.find((field) => values[field] === "invalid");
  if (wrong) return `${FIELD_LABELS[wrong]} must be a number of dollars, 0 or more.`;
  if (values.input === undefined || values.output === undefined) return "Enter an input and an output price.";
  return {
    input: values.input as number,
    output: values.output as number,
    ...(values.cacheRead !== undefined ? { cacheRead: values.cacheRead as number } : {}),
    ...(values.cacheWrite !== undefined ? { cacheWrite: values.cacheWrite as number } : {}),
  };
}

const EMPTY: Readonly<Record<string, ModelPrice>> = {};

function RateInput({ label, value, placeholder, disabled, onChange }: { label: string; value: string; placeholder: string; disabled: boolean; onChange(value: string): void }) {
  return (
    <input
      className="settings-input usage-rate"
      inputMode="decimal"
      aria-label={label}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** One saved price; removing it clears its entry, so the automatic price shows through again. */
function PriceRow({ model, price, draft, disabled, onDraft }: { model: string; price: ModelPrice; draft: Draft | undefined; disabled: boolean; onDraft(draft: Draft | undefined): void }) {
  const entry = useSetting<ModelPrice | undefined>(`modelPrices.${model}`, { defaultValue: undefined });
  const error = draft ? priceFromDraft(draft, price) : undefined;
  return (
    <tr data-changed={draft ? "true" : undefined}>
      <td><code>{model}</code>{typeof error === "string" ? <small className="usage-price-error">{error}</small> : null}</td>
      {FIELDS.map((field) => (
        <td key={field} className="usage-number">
          <RateInput
            label={`${FIELD_LABELS[field]} price of ${model}`}
            value={draft?.[field] ?? (price[field] === undefined ? "" : String(price[field]))}
            placeholder={field === "input" || field === "output" ? "" : "= input"}
            disabled={disabled}
            onChange={(value) => onDraft({ ...draft, [field]: value })}
          />
        </td>
      ))}
      <td className="usage-number">
        <button type="button" className="usage-link" disabled={disabled} onClick={() => { onDraft(undefined); entry.reset(); }}>
          Reset to automatic
        </button>
      </td>
    </tr>
  );
}

/**
 * The user's own model prices (`modelPrices`). They replace every other price
 * where Tau prices tokens: a thread's cost, a subscription's API value, the
 * model picker. Kept for this machine.
 */
export function ModelPrices({ suggestions }: { suggestions: readonly string[] }) {
  const setting = useSetting<Readonly<Record<string, ModelPrice>>>("modelPrices", { defaultValue: EMPTY, read: readPrices });
  const prices = setting.value;
  const models = useMemo(() => Object.keys(prices).sort(), [prices]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [adding, setAdding] = useState<{ model: string } & Draft>({ model: "" });
  const [message, setMessage] = useState<string>();
  const disabled = !setting.writable;

  const edited = Object.entries(drafts).filter(([model]) => prices[model]);
  const errors = edited.map(([model, draft]) => priceFromDraft(draft, prices[model])).filter((result): result is string => typeof result === "string");

  const save = () => {
    if (errors.length > 0) return;
    const next = { ...prices };
    for (const [model, draft] of edited) next[model] = priceFromDraft(draft, prices[model]) as ModelPrice;
    setting.set(next);
    setDrafts({});
    setMessage(`Saved ${edited.length} ${edited.length === 1 ? "price" : "prices"}.`);
  };

  const add = () => {
    const model = adding.model.trim();
    if (!model) { setMessage("Enter a model id: provider/id, or the id alone for every provider."); return; }
    if (prices[model]) { setMessage("This model already has a price. Edit it in its row."); return; }
    const price = priceFromDraft(adding);
    if (typeof price === "string") { setMessage(price); return; }
    setting.set({ ...prices, [model]: price });
    setAdding({ model: "" });
    setMessage(`Added a price for ${model}.`);
  };

  return (
    <div className="usage-prices" aria-label="Model prices">
      <p className="settings-note">
        US dollars per million tokens. A price here replaces the runtime&apos;s and the provider&apos;s list price wherever Tau prices tokens:
        what a thread cost, what a subscription&apos;s usage would have cost over the API, and the model picker&apos;s price column and sort.
        Name a model as <code>provider/id</code>, or by its id alone for every provider. A blank cache rate is the input rate.
      </p>
      {disabled ? <div className="settings-note">Prices are kept for this machine; switch Settings to This machine to change them.</div> : null}
      {models.length > 0 ? (
        <table className="inspector-table usage-table usage-price-table" aria-label="Your model prices">
          <thead>
            <tr>
              <th>Model</th>
              {FIELDS.map((field) => <th key={field} className="usage-number">{FIELD_LABELS[field]}</th>)}
              <th className="usage-number" aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <PriceRow
                key={model}
                model={model}
                price={prices[model]!}
                draft={drafts[model]}
                disabled={disabled}
                onDraft={(draft) => setDrafts((held) => {
                  const next = { ...held };
                  if (draft) next[model] = draft; else delete next[model];
                  return next;
                })}
              />
            ))}
          </tbody>
        </table>
      ) : null}
      {edited.length > 0 ? (
        <div className="usage-price-actions">
          <button type="button" className="usage-refresh" disabled={disabled || errors.length > 0} onClick={save}>Save changes</button>
          <button type="button" className="usage-link" onClick={() => setDrafts({})}>Discard</button>
        </div>
      ) : null}
      <div className="usage-price-add" role="group" aria-label="Add a model price">
        <input
          className="settings-input usage-price-model"
          aria-label="Model id"
          placeholder="openai/gpt-5.6-luna"
          list="usage-price-models"
          value={adding.model}
          disabled={disabled}
          onChange={(event) => setAdding((held) => ({ ...held, model: event.target.value }))}
        />
        <datalist id="usage-price-models">
          {suggestions.filter((model) => !prices[model]).map((model) => <option key={model} value={model} />)}
        </datalist>
        {FIELDS.map((field) => (
          <RateInput
            key={field}
            label={`${FIELD_LABELS[field]} price`}
            value={adding[field] ?? ""}
            placeholder={field === "input" || field === "output" ? FIELD_LABELS[field] : `${FIELD_LABELS[field]} (= input)`}
            disabled={disabled}
            onChange={(value) => setAdding((held) => ({ ...held, [field]: value }))}
          />
        ))}
        <button type="button" className="usage-refresh" disabled={disabled} onClick={add}>Add price</button>
      </div>
      {message ? <div className="settings-note" role="status">{message}</div> : null}
    </div>
  );
}
