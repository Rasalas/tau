import type { HostExtensionServices, HostReadiness, HostRuntimeChoice, UiRuntimeCatalog } from "tau/host-extension";

export function sameModel(model: string | undefined, parent: string | undefined): boolean {
  return model === undefined || model === parent || (!model.includes("/") && model === parent?.slice(parent.indexOf("/") + 1));
}

function describe(choices: HostRuntimeChoice[]): string {
  return choices.map(({ backend, enabled, readiness, catalog }) => {
    const state = enabled ? readiness.state : "turned off for this project";
    const models = catalog?.models.map((model) => `${model.provider}/${model.id}`).join(", ") || "no known models";
    return `${backend.kind} (${state}): ${models}`;
  }).join("; ") || "none";
}

/** Resolve picker ids and bare runtime model ids before creating any child state. */
export async function delegationModel(services: HostExtensionServices, cwd: string, runtime: string, model: string | undefined, machine?: string): Promise<string | undefined> {
  const read = machine ? async (kind?: string): Promise<HostRuntimeChoice[]> => {
    if (!services.machines) throw new Error("This machine cannot reach the selected machine.");
    const readiness = await services.machines.request(machine, "readiness") as HostReadiness;
    return Promise.all(readiness.runtimes.filter((entry) => !kind || entry.kind === kind).map(async (entry) => ({
      backend: { kind: entry.kind, label: entry.label }, enabled: true, readiness: entry,
      catalog: await services.machines!.request(machine, "runtime-catalog", [entry.kind]) as UiRuntimeCatalog | undefined,
    })));
  } : services.runtimeChoices ? (kind?: string) => services.runtimeChoices!(cwd, kind) : undefined;
  if (!read) throw new Error("This machine cannot validate runtime choices. Update Tau on it before selecting a runtime or model.");
  const choices = await read(runtime);
  const choice = choices[0];
  const fail = async (reason: string): Promise<never> => {
    const available = await read();
    throw new Error(`${reason} Available runtimes and models: ${describe(available)}.`);
  };
  if (!choice) return fail(`Unknown runtime "${runtime}".`);
  if (!choice.enabled) return fail(`Runtime "${runtime}" is turned off for this project. Enable it under Settings → Runtimes.`);
  if (choice.readiness.state !== "ready") return fail(`Runtime "${runtime}" is ${choice.readiness.state}. ${choice.readiness.note ?? ""}`);
  if (model === undefined) return undefined;
  const matches = choice.catalog?.models.filter((candidate) => model === `${candidate.provider}/${candidate.id}` || model === candidate.id) ?? [];
  if (matches.length !== 1) return fail(`Unknown or ambiguous model "${model}" for runtime "${runtime}".`);
  const selected = matches[0]!;
  return `${selected.provider}/${selected.id}`;
}

export function inheritedModel(model: { provider: string; id: string } | undefined): string | undefined {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export function nativeDelegationError(): Error {
  return new Error("Use native subagents for this runtime and model, or specify another runtime or model with tau_spawn_thread.");
}
