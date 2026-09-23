import type { ExtensionUiAnswer } from "../shared/contracts.js";
import { splitOption } from "../shared/extension-prompt-options.js";
import type { BackendPrompt } from "./host-extensions.js";

/**
 * An MCP elicitation form (`requestedSchema`, the same shape in MCP, Codex's
 * app-server and ACP) asked as one dialog per field on the workbench's
 * dialog surface. A runtime backend reads the fields, asks them, and sends
 * the content back in its protocol's spelling.
 */
export type ElicitationValue = string | number | boolean | string[];

export interface ElicitationField {
  key: string;
  title: string;
  description?: string;
  required: boolean;
  kind: "text" | "number" | "integer" | "boolean" | "choice" | "choices";
  /** For `choice` and `choices`: what is sent, and what the user reads. */
  options?: Array<{ value: string; label: string }>;
  default?: ElicitationValue;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  /** `email`, `uri`, `date` or `date-time` for text. */
  format?: string;
}

export type ElicitationOutcome =
  | { action: "accept"; content: Record<string, ElicitationValue> }
  | { action: "decline" }
  | { action: "cancel" };

export interface ElicitationFormInput {
  /** Who asks, usually the MCP server's name; the header of every question. */
  source: string;
  message: string;
  fields: readonly ElicitationField[];
  ask(prompt: BackendPrompt): Promise<ExtensionUiAnswer>;
  /** Sees each prompt before it is asked, with the field's place among all of them. */
  decorate?(prompt: BackendPrompt, index: number, fields: readonly ElicitationField[]): void;
}

const YES = "Yes";
const NO = "No";
const MAX_ATTEMPTS = 3;
const MAX_FIELDS = 32;

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : typeof value === "bigint" ? Number(value) : undefined;
}

function constOptions(value: unknown): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(value)) return undefined;
  const options = value.flatMap((entry) => {
    const item = entry as { const?: unknown; title?: unknown } | null;
    return typeof item?.const === "string" ? [{ value: item.const, label: text(item.title) ?? item.const }] : [];
  });
  return options.length === value.length && options.length > 0 ? options : undefined;
}

function enumOptions(values: unknown, names: unknown): Array<{ value: string; label: string }> | undefined {
  if (!Array.isArray(values) || values.length === 0 || !values.every((value) => typeof value === "string")) return undefined;
  const labels = Array.isArray(names) ? names : [];
  return (values as string[]).map((value, index) => ({ value, label: text(labels[index]) ?? value }));
}

function field(key: string, raw: unknown, required: boolean): ElicitationField | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const schema = raw as Record<string, unknown>;
  const base = {
    key,
    title: text(schema.title) ?? key,
    ...(text(schema.description) ? { description: text(schema.description)! } : {}),
    required,
  };
  const bounds = {
    ...(finite(schema.minimum) !== undefined ? { minimum: finite(schema.minimum)! } : {}),
    ...(finite(schema.maximum) !== undefined ? { maximum: finite(schema.maximum)! } : {}),
  };
  switch (schema.type) {
    case "boolean":
      return { ...base, kind: "boolean", ...(typeof schema.default === "boolean" ? { default: schema.default } : {}) };
    case "number":
    case "integer":
      return { ...base, kind: schema.type, ...bounds, ...(finite(schema.default) !== undefined ? { default: finite(schema.default)! } : {}) };
    case "array": {
      const items = (schema.items ?? {}) as Record<string, unknown>;
      const options = constOptions(items.anyOf) ?? constOptions(items.oneOf) ?? enumOptions(items.enum, undefined);
      if (!options) return undefined;
      const fallback = Array.isArray(schema.default) ? schema.default.filter((value): value is string => typeof value === "string") : undefined;
      return { ...base, kind: "choices", options, ...(fallback?.length ? { default: fallback } : {}) };
    }
    case "string":
    case undefined: {
      const options = constOptions(schema.oneOf) ?? constOptions(schema.anyOf) ?? enumOptions(schema.enum, schema.enumNames);
      const fallback = typeof schema.default === "string" ? { default: schema.default } : {};
      if (options) return { ...base, kind: "choice", options, ...fallback };
      if (schema.type === undefined) return undefined;
      return {
        ...base,
        kind: "text",
        ...(finite(schema.minLength) !== undefined ? { minLength: finite(schema.minLength)! } : {}),
        ...(finite(schema.maxLength) !== undefined ? { maxLength: finite(schema.maxLength)! } : {}),
        ...(text(schema.format) ? { format: text(schema.format)! } : {}),
        ...fallback,
      };
    }
    default:
      return undefined;
  }
}

/**
 * The fields of a `requestedSchema`, in the schema's order; `[]` for a form
 * that asks nothing, `undefined` when a field is of a kind no dialog asks.
 */
export function elicitationFields(schema: unknown): ElicitationField[] | undefined {
  if (!schema || typeof schema !== "object") return undefined;
  const { properties, required } = schema as { properties?: unknown; required?: unknown };
  if (properties !== undefined && (properties === null || typeof properties !== "object" || Array.isArray(properties))) return undefined;
  const needed = new Set(Array.isArray(required) ? required.filter((entry): entry is string => typeof entry === "string") : []);
  const entries = Object.entries((properties ?? {}) as Record<string, unknown>);
  if (entries.length > MAX_FIELDS) return undefined;
  const fields: ElicitationField[] = [];
  for (const [key, raw] of entries) {
    const parsed = field(key, raw, needed.has(key));
    if (!parsed) return undefined;
    fields.push(parsed);
  }
  return fields;
}

function describe(value: ElicitationValue): string {
  return Array.isArray(value) ? value.join(", ") : typeof value === "boolean" ? (value ? YES : NO) : String(value);
}

/** The title a field's dialog carries. */
export function elicitationFieldTitle(item: ElicitationField): string {
  return item.required ? item.title : `${item.title} (optional)`;
}

/** The dialog a field is asked in; a multi-choice is an input listing its options, as the ask-user tool asks one. */
function promptFor(input: ElicitationFormInput, item: ElicitationField, problem?: string): BackendPrompt {
  const title = elicitationFieldTitle(item);
  const hint = item.default !== undefined ? `Default: ${describe(item.default)}` : undefined;
  const message = [problem, input.message.trim(), item.description, hint].filter(Boolean).join("\n\n");
  const common = { ...(message ? { message } : {}) };
  switch (item.kind) {
    case "boolean":
      return { kind: "select", title, options: [YES, NO], ...common };
    case "choice":
      return { kind: "select", title, options: item.options!.map((option) => option.label), ...common };
    case "choices": {
      // Everything after the title's blank line is detail: shown where the options are not drawn as rows.
      const list = item.options!.map((option, index) => `${index + 1}. ${option.label}`).join("\n");
      return { kind: "input", title: `${title}\n\n${[message, `Pick any of these, as numbers separated by commas:\n${list}`].filter(Boolean).join("\n\n")}` };
    }
    default:
      return { kind: "input", title, ...(hint ? { placeholder: describe(item.default!) } : {}), ...common };
  }
}

type Parsed = { value: ElicitationValue } | { skip: true } | { problem: string };

function choose(item: ElicitationField, answer: string): string | undefined {
  const wanted = answer.trim().toLowerCase();
  const label = splitOption(answer).label.toLowerCase();
  return item.options!.find((option) => option.label.toLowerCase() === wanted || option.value.toLowerCase() === wanted || option.label.toLowerCase() === label)?.value;
}

function parse(item: ElicitationField, raw: string): Parsed {
  const answer = raw.trim();
  if (!answer) {
    if (item.default !== undefined) return { value: item.default };
    return item.required ? { problem: "This field needs an answer." } : { skip: true };
  }
  switch (item.kind) {
    case "boolean": {
      const word = answer.toLowerCase();
      if ([YES.toLowerCase(), "y", "true"].includes(word)) return { value: true };
      if ([NO.toLowerCase(), "n", "false"].includes(word)) return { value: false };
      return { problem: "Answer Yes or No." };
    }
    case "choice": {
      const value = choose(item, answer);
      return value !== undefined ? { value } : { problem: `Pick one of: ${item.options!.map((option) => option.label).join(", ")}.` };
    }
    case "choices": {
      const picked = answer.split(/\s*,\s*/u).filter(Boolean).map((token) => /^\d+$/u.test(token) ? item.options![Number(token) - 1]?.value : choose(item, token));
      if (picked.some((value) => value === undefined)) return { problem: "Name the options by their numbers, separated by commas." };
      return { value: [...new Set(picked as string[])] };
    }
    case "number":
    case "integer": {
      const value = Number(answer);
      if (!Number.isFinite(value) || (item.kind === "integer" && !Number.isInteger(value))) return { problem: item.kind === "integer" ? "Enter a whole number." : "Enter a number." };
      if (item.minimum !== undefined && value < item.minimum) return { problem: `Enter at least ${item.minimum}.` };
      if (item.maximum !== undefined && value > item.maximum) return { problem: `Enter at most ${item.maximum}.` };
      return { value };
    }
    default: {
      if (item.minLength !== undefined && answer.length < item.minLength) return { problem: `Enter at least ${item.minLength} characters.` };
      if (item.maxLength !== undefined && answer.length > item.maxLength) return { problem: `Enter at most ${item.maxLength} characters.` };
      if (item.format === "email" && !/^[^\s@]+@[^\s@]+$/u.test(answer)) return { problem: "Enter an email address." };
      if (item.format === "uri" && !/^[a-z][a-z0-9+.-]*:/iu.test(answer)) return { problem: "Enter a URL." };
      return { value: answer };
    }
  }
}

/**
 * Asks each field in turn. Skipping a required field declines the form, as
 * does skipping every field; an answer that does not fit is asked again.
 */
export async function askElicitation(input: ElicitationFormInput): Promise<ElicitationOutcome> {
  const content: Record<string, ElicitationValue> = {};
  for (const [index, item] of input.fields.entries()) {
    let problem: string | undefined;
    for (let attempt = 0; ; attempt += 1) {
      if (attempt === MAX_ATTEMPTS) return { action: "decline" };
      const prompt = promptFor(input, item, problem);
      input.decorate?.(prompt, index, input.fields);
      const answer = await input.ask(prompt);
      if ("cancelled" in answer) {
        if (item.required) return { action: "decline" };
        break;
      }
      const raw = "value" in answer ? answer.value : "confirmed" in answer ? (answer.confirmed ? YES : NO) : "";
      const parsed = parse(item, raw);
      if ("value" in parsed) {
        content[item.key] = parsed.value;
        break;
      }
      if ("skip" in parsed) break;
      problem = parsed.problem;
    }
  }
  if (input.fields.length > 0 && Object.keys(content).length === 0) return { action: "decline" };
  return { action: "accept", content };
}
