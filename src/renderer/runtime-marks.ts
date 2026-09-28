import type { UiModel, UiThreadUsage } from "../shared/contracts";
import { runtimeDriver } from "../shared/runtime-instances";

/** The runtime a thread gets unless another is chosen. */
export const DEFAULT_RUNTIME = "pi";

/**
 * Model providers a runtime owns, by program: beside one of them the runtime's
 * mark says it all. A runtime is home to a provider of its own name as well.
 */
export const HOME_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  codex: ["openai"],
  "claude-code": ["anthropic"],
  grok: ["xai"],
  antigravity: ["google"],
  opencode: ["opencode-go"],
};

/** Providers that are a subscription plan by name; others are one when the caller says so. */
const PLAN_PROVIDERS: ReadonlySet<string> = new Set(["openai-codex"]);

export interface ProviderMarks {
  /** The model provider's mark. */
  model?: string;
  /** The runtime's mark. */
  runtime?: string;
  /** The model mark stands for a subscription plan, not an API key. */
  plan?: boolean;
  /** The runtime's home provider: not drawn, named in the tooltip. */
  home?: string;
}

/** An instance (`codex@work`) wears its program's mark. */
function spelling(value: string): string {
  return runtimeDriver(value).toLocaleLowerCase().replace(/[_.\s]/gu, "-");
}

function isHome(runtime: string, modelProvider: string): boolean {
  const driver = spelling(runtime);
  const provider = spelling(modelProvider);
  return driver === provider || (HOME_PROVIDERS[driver]?.includes(provider) ?? false);
}

/**
 * Which marks stand for a model and the runtime that runs it. A runtime with
 * its home provider shows its own mark alone; any other pair shows both, Pi
 * included. Without a runtime (a list that is one runtime's) the model's
 * mark stands alone; without a model the runtime's does.
 */
export function providerMarks(modelProvider: string | undefined, runtime: string | undefined, options: { plan?: boolean } = {}): ProviderMarks {
  if (!modelProvider) return runtime ? { runtime } : {};
  if (runtime && isHome(runtime, modelProvider)) return { runtime, home: modelProvider };
  const plan = options.plan === true || PLAN_PROVIDERS.has(spelling(modelProvider));
  return { model: modelProvider, ...(runtime ? { runtime } : {}), ...(plan ? { plan } : {}) };
}

/** A model reached through a subscription login rather than an API key. */
export function modelOnPlan(model: Pick<UiModel, "login" | "billing">): boolean {
  return model.login === "subscription" || model.billing === "subscription";
}

/** A thread that ran mostly on a subscription, which is all a row knows of its login. */
export function threadOnPlan(usage: UiThreadUsage | undefined): boolean {
  const plan = usage?.subscription;
  return Boolean(usage && plan && plan.totalTokens > 0 && plan.totalTokens * 2 >= usage.totalTokens);
}
