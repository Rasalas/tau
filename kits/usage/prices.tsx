import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import { Button, NumberField, SettingsState, tooltipProps, useSetting } from "tau";

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
const UNIT = "$/M";
const optional = (field: Field) => field === "cacheRead" || field === "cacheWrite";

/**
 * One saved price, each rate written when its field is left. An emptied cache
 * rate goes back to the input rate; Reset removes the entry, so the automatic
 * price shows through again.
 */
function PriceRow({ model, price, disabled, onChange }: { model: string; price: ModelPrice; disabled: boolean; onChange(price: ModelPrice): void }) {
  const entry = useSetting<ModelPrice | undefined>(`modelPrices.${model}`, { defaultValue: undefined });
  const without = (field: Field): ModelPrice => {
    const next = { ...price };
    delete next[field];
    return next;
  };
  return (
    <tr>
      <td><code>{model}</code></td>
      {FIELDS.map((field) => (
        <td key={field} className="usage-number">
          <NumberField
            label={`${FIELD_LABELS[field]} price of ${model}`}
            value={price[field]}
            min={0}
            unit={UNIT}
            width="full"
            placeholder={optional(field) ? "= input" : ""}
            disabled={disabled}
            onCommit={(value) => onChange({ ...price, [field]: value })}
            {...(optional(field) ? { onClear: () => { if (price[field] !== undefined) onChange(without(field)); } } : {})}
          />
        </td>
      ))}
      <td className="usage-number">
        <Button variant="ghost" aria-label={`Reset ${model} to automatic`} {...tooltipProps("Remove this price; the automatic one applies again")} disabled={disabled} onClick={() => entry.reset()}>
          Reset to automatic
        </Button>
      </td>
    </tr>
  );
}

type Adding = { model: string } & Partial<Record<Field, number>>;

/**
 * The user's own model prices (`modelPrices`). They replace every other price
 * where Tau prices tokens: a thread's cost, a subscription's API value, the
 * model picker. Kept for this machine.
 */
export function ModelPrices({ suggestions }: { suggestions: readonly string[] }) {
  const setting = useSetting<Readonly<Record<string, ModelPrice>>>("modelPrices", { defaultValue: EMPTY, read: readPrices });
  const prices = setting.value;
  const models = useMemo(() => Object.keys(prices).sort(), [prices]);
  const [adding, setAdding] = useState<Adding>({ model: "" });
  const [message, setMessage] = useState<{ text: string; problem: boolean }>();
  const disabled = !setting.writable;

  const add = () => {
    const model = adding.model.trim();
    if (!model) { setMessage({ text: "Enter a model id: provider/id, or the id alone for every provider.", problem: true }); return; }
    if (prices[model]) { setMessage({ text: "This model already has a price. Change it in its row.", problem: true }); return; }
    const price = priceFromDraft(Object.fromEntries(FIELDS.flatMap((field) => (adding[field] === undefined ? [] : [[field, String(adding[field])]]))));
    if (typeof price === "string") { setMessage({ text: price, problem: true }); return; }
    setting.set({ ...prices, [model]: price });
    setAdding({ model: "" });
    setMessage({ text: `Added a price for ${model}.`, problem: false });
  };
  const setRate = (field: Field) => (value: number | undefined) => setAdding((held) => {
    const next = { ...held };
    if (value === undefined) delete next[field]; else next[field] = value;
    return next;
  });

  return (
    <div className="usage-prices" aria-label="Model prices">
      <p className="usage-prices-lede">
        US dollars per million tokens ({UNIT}). A price here replaces the runtime&apos;s and the provider&apos;s list price wherever Tau
        prices tokens: what a thread cost, what a subscription&apos;s usage would have cost over the API, and the model picker.
        Name a model as <code>provider/id</code>, or by its id alone for every provider. A blank cache rate is the input rate.
      </p>
      {disabled ? <p className="usage-prices-lede">{setting.readOnly ? "This device is paired Read only: it can see the prices, not change them." : "Prices are kept for this machine; switch Settings to This machine to change them."}</p> : null}
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
              <PriceRow key={model} model={model} price={prices[model]!} disabled={disabled} onChange={(price) => setting.set({ ...prices, [model]: price })} />
            ))}
          </tbody>
        </table>
      ) : (
        <SettingsState kind="empty" title="No prices of your own" description="Tau uses the runtime's or the provider's list price. Add a model below to price it yourself." />
      )}
      <form className="usage-price-add" aria-label="Add a model price" onSubmit={(event) => { event.preventDefault(); add(); }}>
        {/* A native field for the model id: the ids this machine used are offered as suggestions. */}
        <span className="tau-field-shell" data-width="full">
          <span className="tau-field">
            <input
              data-mono=""
              aria-label="Model id"
              placeholder="openai/gpt-5.6-luna"
              list="usage-price-models"
              spellCheck={false}
              value={adding.model}
              disabled={disabled}
              onChange={(event) => setAdding((held) => ({ ...held, model: event.target.value }))}
            />
          </span>
        </span>
        <datalist id="usage-price-models">
          {suggestions.filter((model) => !prices[model]).map((model) => <option key={model} value={model} />)}
        </datalist>
        {FIELDS.map((field) => (
          <NumberField
            key={field}
            label={`${FIELD_LABELS[field]} price`}
            value={adding[field]}
            min={0}
            unit={UNIT}
            width="full"
            placeholder={optional(field) ? `${FIELD_LABELS[field]} (= input)` : FIELD_LABELS[field]}
            disabled={disabled}
            onCommit={setRate(field)}
            onClear={() => setRate(field)(undefined)}
          />
        ))}
        <Button type="submit" icon={<Plus size={13} />} disabled={disabled}>Add price</Button>
      </form>
      {message ? <p className="usage-price-message" data-problem={message.problem ? "" : undefined} role="status">{message.text}</p> : null}
    </div>
  );
}
