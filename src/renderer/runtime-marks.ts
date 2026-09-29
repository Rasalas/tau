import { useSyncExternalStore } from "react";
import type { UiModel, UiRuntimeBackend, UiThreadUsage } from "../shared/contracts";
import { runtimeDriver } from "../shared/runtime-instances";

/** The runtime a thread gets unless another is chosen. */
export const DEFAULT_RUNTIME = "pi";

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

/** What runtimes declared of their marks (`homeProviders`, `ownPlan`), by program. */
export type RuntimeMarkDeclarations = ReadonlyMap<string, { homes: ReadonlySet<string>; ownPlan: boolean }>;

/** An instance (`codex@work`) wears its program's mark. */
function spelling(value: string): string {
  return runtimeDriver(value).toLocaleLowerCase().replace(/[_.\s]/gu, "-");
}

/** How a provider or runtime is keyed for its mark, whichever way it is written. */
export const providerIconKey = spelling;

let declared: RuntimeMarkDeclarations = new Map();
let declaredKey = "";
const listeners = new Set<() => void>();

/**
 * Takes the host's `runtimeBackends` as what runtimes say of their marks; the
 * first instance of a program speaks for it. Undefined keeps what was known.
 */
export function declareRuntimeMarks(backends: readonly Pick<UiRuntimeBackend, "kind" | "homeProviders" | "ownPlan">[] | undefined): void {
  if (!backends) return;
  const next = new Map<string, { homes: ReadonlySet<string>; ownPlan: boolean }>();
  for (const backend of backends) {
    const program = spelling(backend.kind);
    if (!next.has(program)) next.set(program, { homes: new Set((backend.homeProviders ?? []).map(spelling)), ownPlan: backend.ownPlan === true });
  }
  const key = JSON.stringify([...next].map(([program, entry]) => [program, [...entry.homes], entry.ownPlan]));
  if (key === declaredKey) return;
  declared = next;
  declaredKey = key;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The declarations, re-rendering the caller when they change. */
export function useRuntimeMarkDeclarations(): RuntimeMarkDeclarations {
  return useSyncExternalStore(subscribe, () => declared, () => declared);
}

function isHome(runtime: string, modelProvider: string, runtimes: RuntimeMarkDeclarations): boolean {
  const driver = spelling(runtime);
  const provider = spelling(modelProvider);
  return driver === provider || (runtimes.get(driver)?.homes.has(provider) ?? false);
}

/**
 * Which marks stand for a model and the runtime that runs it. A runtime with
 * a provider it owns (its declared `homeProviders`, or its own name) shows its
 * own mark alone; any other pair shows both, Pi included. A plan is the
 * provider's unless the runtime says its plans are its own. Without a runtime
 * (a list that is one runtime's) the model's mark stands alone; without a
 * model the runtime's does.
 */
export function providerMarks(
  modelProvider: string | undefined,
  runtime: string | undefined,
  options: { plan?: boolean; runtimes?: RuntimeMarkDeclarations } = {},
): ProviderMarks {
  const runtimes = options.runtimes ?? declared;
  if (!modelProvider) return runtime ? { runtime } : {};
  if (runtime && isHome(runtime, modelProvider, runtimes)) return { runtime, home: modelProvider };
  const ownPlan = runtime !== undefined && (runtimes.get(spelling(runtime))?.ownPlan ?? false);
  const plan = !ownPlan && (options.plan === true || PLAN_PROVIDERS.has(spelling(modelProvider)));
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
