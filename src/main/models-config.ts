import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import type { CustomModelDefinition, CustomProviderConfig, CustomProviderInput } from "../shared/contracts.js";

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

  let rawModels: Record<string, unknown> = {};
  if (existsSync(modelsPath)) {
    try {
      rawModels = JSON.parse(await fs.readFile(modelsPath, "utf8")) as Record<string, unknown>;
    } catch {
      rawModels = {};
    }
  }

  let rawAuth: Record<string, unknown> = {};
  if (existsSync(authPath)) {
    try {
      rawAuth = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
    } catch {
      rawAuth = {};
    }
  }

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

  await fs.mkdir(agentDir, { recursive: true, mode: 0o700 });

  const modelsPath = join(agentDir, "models.json");
  const authPath = join(agentDir, "auth.json");

  // Update models.json
  let modelsJson: { providers?: Record<string, unknown> } = { providers: {} };
  if (existsSync(modelsPath)) {
    try {
      modelsJson = JSON.parse(await fs.readFile(modelsPath, "utf8")) as { providers?: Record<string, unknown> };
      if (!modelsJson.providers || typeof modelsJson.providers !== "object") {
        modelsJson.providers = {};
      }
    } catch {
      modelsJson = { providers: {} };
    }
  }

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

  const modelsTmp = `${modelsPath}.${Date.now()}.tmp`;
  await fs.writeFile(modelsTmp, `${JSON.stringify(modelsJson, null, 2)}\n`, "utf8");
  await fs.rename(modelsTmp, modelsPath);

  // Update auth.json if apiKey is provided
  if (input.apiKey && input.apiKey.trim()) {
    let authJson: Record<string, unknown> = {};
    if (existsSync(authPath)) {
      try {
        authJson = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, unknown>;
      } catch {
        authJson = {};
      }
    }
    authJson[pid] = { type: "api_key", key: input.apiKey.trim() };
    const authTmp = `${authPath}.${Date.now()}.tmp`;
    await fs.writeFile(authTmp, `${JSON.stringify(authJson, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(authTmp, authPath);
  }
}
