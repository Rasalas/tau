import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { addModelProvider, loadModelsConfig, validateProviderInput } from "./models-config.js";

describe("models-config", () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tau-models-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(testDir, { recursive: true });
  });

  afterEach(async () => {
    if (existsSync(testDir)) {
      await fs.rm(testDir, { recursive: true, force: true });
    }
  });

  describe("validateProviderInput", () => {
    it("validates valid input without throwing", () => {
      expect(() => validateProviderInput({
        providerId: "ollama",
        name: "Ollama Local",
        baseUrl: "http://localhost:11434/v1",
        models: [{ id: "llama3", name: "Llama 3" }],
      })).not.toThrow();
    });

    it("rejects invalid provider ID", () => {
      expect(() => validateProviderInput({
        providerId: "invalid/id",
        models: [{ id: "m1" }],
      })).toThrow("Invalid provider ID");

      expect(() => validateProviderInput({
        providerId: "",
        models: [{ id: "m1" }],
      })).toThrow("Invalid provider ID");
    });

    it("rejects invalid baseUrl", () => {
      expect(() => validateProviderInput({
        providerId: "test",
        baseUrl: "ftp://example.com",
        models: [{ id: "m1" }],
      })).toThrow("Invalid base URL");
    });

    it("rejects empty models array or invalid model ID", () => {
      expect(() => validateProviderInput({
        providerId: "test",
        models: [],
      })).toThrow("At least one model definition is required");

      expect(() => validateProviderInput({
        providerId: "test",
        models: [{ id: "   " }],
      })).toThrow("Each model must specify a non-empty ID");
    });
  });

  describe("loadModelsConfig and addModelProvider", () => {
    it("returns empty array if models.json does not exist", async () => {
      const result = await loadModelsConfig(testDir);
      expect(result).toEqual([]);
    });

    it("saves provider to models.json and auth.json, then loads correctly", async () => {
      await addModelProvider(testDir, {
        providerId: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        apiKey: "sk-or-12345",
        models: [
          { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", contextWindow: 200000 },
        ],
      });

      const providers = await loadModelsConfig(testDir);
      expect(providers).toHaveLength(1);
      expect(providers[0]).toEqual({
        providerId: "openrouter",
        name: "OpenRouter",
        baseUrl: "https://openrouter.ai/api/v1",
        api: "openai-compatible",
        hasApiKey: true,
        models: [
          {
            id: "anthropic/claude-3.5-sonnet",
            name: "Claude 3.5 Sonnet",
            reasoning: undefined,
            contextWindow: 200000,
            maxTokens: undefined,
          },
        ],
      });

      // Verify auth.json exists and has restricted mode
      const authPath = join(testDir, "auth.json");
      expect(existsSync(authPath)).toBe(true);
      const authRaw = JSON.parse(await fs.readFile(authPath, "utf8")) as Record<string, { type: string; key: string }>;
      expect(authRaw.openrouter.key).toBe("sk-or-12345");
    });

    it("preserves existing providers when adding a new one", async () => {
      await addModelProvider(testDir, {
        providerId: "p1",
        models: [{ id: "m1" }],
      });

      await addModelProvider(testDir, {
        providerId: "p2",
        models: [{ id: "m2" }],
      });

      const providers = await loadModelsConfig(testDir);
      expect(providers.map((p) => p.providerId)).toEqual(["p1", "p2"]);
    });
  });
});
