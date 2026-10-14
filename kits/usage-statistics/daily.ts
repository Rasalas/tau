import { runtimeDriver, type ClientStorage } from "tau";
import { sendEvent, type SendEvent, type TrackedEvent, type UsageStatistics } from "./statistics.js";

export const DAILY_KEY = "device:tau.usage-statistics.daily.v1";
const RETRY_MS = 5 * 60_000;
/** A summary older than this is dropped unsent; the visit would land on the wrong week. */
const MAX_AGE_DAYS = 7;
const MAX_ROWS = 40;

/** Only these values leave the device; anything else is reported as `other`. */
const RUNTIMES = new Set(["pi", "claude-code", "codex", "opencode", "antigravity", "cursor", "grok"]);
const PROVIDERS = new Set(["anthropic", "openai", "openai-codex", "google", "google-gemini-cli", "google-antigravity", "opencode", "opencode-go", "deepseek", "xai", "mistral", "openrouter", "github-copilot", "groq", "cursor"]);
const REASONING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ACCESS = new Set(["read-only", "ask", "auto", "full"]);
export type RunOutcome = "ok" | "error" | "limit";

export interface PromptInfo {
  backendKind?: string;
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  access?: string;
}

interface Summary {
  day: string;
  prompts: Record<string, number>;
  runs: Record<string, number>;
}

export function runtimeLabel(kind: string | undefined): string {
  const driver = runtimeDriver(kind ?? "pi");
  return RUNTIMES.has(driver) ? driver : "other";
}

/** A self-hosted provider's model name can say whose it is; only known providers name theirs. */
export function modelLabel(model: PromptInfo["model"]): string {
  if (!model || !PROVIDERS.has(model.provider) || !/^[a-z0-9][a-z0-9._:/-]{0,63}$/iu.test(model.id)) return "other";
  return `${model.provider}/${model.id}`;
}

/** Catalog levels read like "default (low)"; the first known word names the level. */
export function reasoningLabel(level: string | undefined): string {
  const words = (level ?? "").toLowerCase().split(/[^a-z]+/u);
  if (words[0] === "default") return "default";
  return REASONING.find((known) => words.includes(known)) ?? (level ? "other" : "default");
}

export function accessLabel(level: string | undefined): string {
  return level && ACCESS.has(level) ? level : "other";
}

/** The rows of one day, as Matomo events whose value is the day's count. */
export function summaryEvents(summary: Summary): TrackedEvent[] {
  const prompts = Object.entries(summary.prompts).map(([key, count]) => {
    const [runtime, model, reasoning, access] = key.split("|");
    return { category: "prompts", action: runtime, name: `${model} · ${reasoning} · ${access}`, value: count };
  });
  const runs = Object.entries(summary.runs).map(([key, count]) => {
    const [runtime, outcome] = key.split("|");
    return { category: "runs", action: runtime, name: outcome, value: count };
  });
  return [...prompts, ...runs];
}

const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** `current` is the day being counted; `pending` a finished day not sent yet. */
interface Stored {
  current?: Summary;
  pending?: Summary;
}

function readSummary(value: unknown): Summary | undefined {
  const summary = value as Partial<Summary> | null;
  if (typeof summary?.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(summary.day)) return undefined;
  const counts = (record: unknown) => Object.fromEntries(Object.entries(record && typeof record === "object" ? record : {})
    .filter((entry): entry is [string, number] => Number.isSafeInteger(entry[1]) && (entry[1] as number) > 0));
  return { day: summary.day, prompts: counts(summary.prompts), runs: counts(summary.runs) };
}

function read(storage: ClientStorage | undefined): Stored {
  try {
    const value = JSON.parse(storage?.get(DAILY_KEY) ?? "null");
    return { current: readSummary(value?.current), pending: readSummary(value?.pending) };
  } catch {
    return {};
  }
}

export class DailyUsage {
  private sending = false;
  private retryAt = 0;

  constructor(private readonly storage: ClientStorage | undefined, private readonly statistics: UsageStatistics,
    private readonly send: SendEvent = sendEvent, private readonly now: () => number = Date.now) {}

  prompt(info: PromptInfo): void {
    const key = [runtimeLabel(info.backendKind), modelLabel(info.model), reasoningLabel(info.thinkingLevel), accessLabel(info.access)].join("|");
    this.count("prompts", key);
  }

  runEnded(backendKind: string | undefined, outcome: RunOutcome): void {
    this.count("runs", `${runtimeLabel(backendKind)}|${outcome}`);
  }

  /** Sends a finished day, if there is one; called on every activity. */
  flush = (): void => {
    const stored = this.roll(read(this.storage));
    const summary = stored.pending;
    if (!summary || this.sending || this.now() < this.retryAt) return;
    const { enabled, id } = this.statistics.getSnapshot();
    const release = this.statistics.getRelease();
    if (!enabled || !id) { this.clear(); return; }
    if (!release) return;
    const events = summaryEvents(summary).slice(0, MAX_ROWS);
    if (events.length === 0 || Date.parse(dayOf(this.now())) - Date.parse(summary.day) > MAX_AGE_DAYS * 86_400_000) {
      this.write({ current: stored.current });
      return;
    }
    this.sending = true;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 10_000);
    void Promise.all(events.map((event) => this.send({ id, release, event }, abort.signal))).then(() => {
      const now = read(this.storage);
      if (now.pending?.day === summary.day) this.write({ current: now.current });
    }, () => { this.retryAt = this.now() + RETRY_MS; }).finally(() => { clearTimeout(timeout); this.sending = false; });
  };

  clear = (): void => { try { this.storage?.remove(DAILY_KEY); } catch { /* nothing to keep */ } };

  private count(kind: "prompts" | "runs", key: string): void {
    if (!this.statistics.getSnapshot().enabled || !this.statistics.getRelease()) return;
    const stored = this.roll(read(this.storage));
    const summary = stored.current ?? { day: dayOf(this.now()), prompts: {}, runs: {} };
    const rows = summary[kind];
    if (key in rows || Object.keys(summary.prompts).length + Object.keys(summary.runs).length < MAX_ROWS) {
      rows[key] = (rows[key] ?? 0) + 1;
      this.write({ ...stored, current: summary });
    }
    this.flush();
  }

  /** A day that ended becomes the one to send; an older unsent one gives way to it. */
  private roll(stored: Stored): Stored {
    if (!stored.current || stored.current.day === dayOf(this.now())) return stored;
    const next = { pending: stored.current };
    this.write(next);
    return next;
  }

  private write(stored: Stored): void {
    try { this.storage?.set(DAILY_KEY, JSON.stringify(stored)); } catch { /* counting is best effort */ }
  }
}
