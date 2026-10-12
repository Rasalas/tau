import { join } from "node:path";
import type { CustomModelDefinition, CustomProviderConfig, CustomProviderInput } from "../shared/contracts.js";
import { editJsonFiles, readJson, writeJson } from "./editable-json.js";

const PROVIDER_ID_REGEX = /^[a-zA-Z0-9_.-]+$/;

export function validateProviderInput(input: CustomProviderInput): void {
  if (!input.providerId || typeof input.providerId !== "string" || !PROVIDER_ID_REGEX.test(input.providerId.trim())) {
    throw new Error("Invalid provider ID: must only contain letters, numbers, hyphens, dots, or underscores.");
  }
  if (input.baseUrl && typeof input.baseUrl === "string" && input.baseUrl.trim()) {
    try {
      const parsed = new URL(input.baseUrl.trim());
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new Error("Protocol must be http: or https:");
      }
    } catch {
      throw new Error("Invalid base URL: must be a valid HTTP or HTTPS URL.");
    }
  }
  if (!Array.isArray(input.models) || input.models.length === 0) {
    throw new Error("At least one model definition is required.");
  }
  for (const model of input.models) {
    if (!model.id || typeof model.id !== "string" || !model.id.trim()) {
      throw new Error("Each model must specify a non-empty ID.");
    }
  }
}

export async function loadModelsConfig(agentDir: string): Promise<CustomProviderConfig[]> {
  const modelsPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");

  const rawModels = (await readJson<Record<string, unknown>>(modelsPath)) ?? {};
  const rawAuth = (await readJson<Record<string, unknown>>(authPath)) ?? {};

  const providers = (rawModels.providers && typeof rawModels.providers === "object"
    ? rawModels.providers
    : {}) as Record<string, Record<string, unknown>>;

  const result: CustomProviderConfig[] = [];
  for (const [providerId, config] of Object.entries(providers)) {
    if (!config || typeof config !== "object") continue;
    const authEntry = rawAuth[providerId] as { key?: string } | undefined;
    const modelsRaw = Array.isArray(config.models) ? config.models : [];
    const models: CustomModelDefinition[] = modelsRaw
      .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && typeof item.id === "string"))
      .map((item) => ({
        id: String(item.id),
        name: typeof item.name === "string" ? item.name : undefined,
        reasoning: typeof item.reasoning === "boolean" ? item.reasoning : undefined,
        contextWindow: typeof item.contextWindow === "number" ? item.contextWindow : undefined,
        maxTokens: typeof item.maxTokens === "number" ? item.maxTokens : undefined,
      }));

    result.push({
      providerId,
      name: typeof config.name === "string" ? config.name : providerId,
      baseUrl: typeof config.baseUrl === "string" ? config.baseUrl : undefined,
      api: typeof config.api === "string" ? config.api : undefined,
      hasApiKey: Boolean(config.apiKey || authEntry?.key),
      models,
    });
  }

  return result;
}

export async function addModelProvider(agentDir: string, input: CustomProviderInput): Promise<void> {
  validateProviderInput(input);

  const modelsPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");
  const apiKey = input.apiKey?.trim();

  await editJsonFiles([modelsPath, ...(apiKey ? [authPath] : [])], async () => {
    const modelsJson = (await readJson<{ providers?: Record<string, unknown> }>(modelsPath)) ?? {};
    const authJson = apiKey ? (await readJson<Record<string, unknown>>(authPath)) ?? {} : undefined;
    if (modelsJson.providers !== undefined && (!modelsJson.providers || typeof modelsJson.providers !== "object" || Array.isArray(modelsJson.providers))) {
      throw new Error(`Cannot read providers from ${modelsPath}: expected a JSON object`);
    }
    modelsJson.providers ??= {};

    const pid = input.providerId.trim();
    modelsJson.providers![pid] = {
      name: input.name?.trim() || pid,
      ...(input.baseUrl?.trim() ? { baseUrl: input.baseUrl.trim() } : {}),
      api: input.api?.trim() || "openai-compatible",
      models: input.models.map((model) => ({
        id: model.id.trim(),
        name: model.name?.trim() || model.id.trim(),
        ...(model.reasoning !== undefined ? { reasoning: model.reasoning } : {}),
        ...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
        ...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
      })),
    };

    await writeJson(modelsPath, modelsJson);
    if (authJson && apiKey) {
      authJson[pid] = { type: "api_key", key: apiKey };
      await writeJson(authPath, authJson);
    }
  });
}
