import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { HostCompletions } from "./host-completion.js";
import { ModelPriceBook, piBilling, piNewThreadCatalog, type PiModelData } from "./model-price-book.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** Pi's own model data, offline, with an API key for OpenAI only. */
async function piCatalog() {
  vi.stubEnv("PI_OFFLINE", "1");
  const agentDir = await mkdtemp(join(tmpdir(), "tau-price-book-"));
  directories.push(agentDir);
  await writeFile(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }));
  const completions = new HostCompletions({
    agentDir,
    cwd: () => agentDir,
    createRuntime: (dir) => ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false }),
    settings: () => ({ getDefaultProvider: () => "openai", getDefaultModel: () => "gpt-5.6-luna" }),
  });
  const data = await completions.catalogData();
  return { data, book: new ModelPriceBook(data.known) };
}

describe("Pi's catalog before a thread", () => {
  it("carries Pi's prices, limits and inputs, and names the default", async () => {
    const { data, book } = await piCatalog();
    const catalog = piNewThreadCatalog({ ...data, book });
    const luna = catalog.models.find((model) => model.id === "gpt-5.6-luna");
    expect(luna).toMatchObject({
      provider: "openai",
      billing: "api-key",
      price: { input: 0.2, output: 1.2, cacheRead: 0.02 },
      contextWindow: 272_000,
      maxOutput: 128_000,
      images: true,
      reasoning: true,
    });
    expect(catalog.model).toMatchObject({ provider: "openai", id: "gpt-5.6-luna" });
    // Only what the key reaches; the rest of Pi's data is the book.
    expect(catalog.models.every((model) => model.provider === "openai")).toBe(true);
    expect(catalog.thinkingLevels).toEqual({});
  });

  it("prices other runtimes' models by Pi's data, an alias by the id it resolves to", async () => {
    const { book } = await piCatalog();
    expect(book.enrich({ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" })).toMatchObject({
      billing: "subscription",
      price: { input: 0.2, output: 1.2 },
      contextWindow: 272_000,
    });
    const opus = book.enrich({ provider: "anthropic", id: "opus[1m]", name: "Opus 5", apiModelId: "claude-opus-5[1m]", reasoning: true });
    expect(opus).toMatchObject({ id: "opus[1m]", price: { input: 5, output: 25 } });
    expect(opus).not.toHaveProperty("apiModelId");
    expect(book.enrich({ provider: "acme", id: "unknown", name: "Unknown" })).toEqual({ provider: "acme", id: "unknown", name: "Unknown" });
  });
});

describe("ModelPriceBook", () => {
  const models: PiModelData[] = [
    { provider: "plan", id: "m-1", cost: { input: 0, output: 0 }, contextWindow: 100, input: ["text"] },
    { provider: "api", id: "m-1", cost: { input: 3, output: 15, cacheRead: 0.3 }, contextWindow: 200, input: ["text", "image"] },
    { provider: "api", id: "m-2", cost: { input: 1, output: 2 } },
  ];
  const book = new ModelPriceBook(() => models);

  it("keeps the provider's own facts and borrows a price another provider names", () => {
    expect(book.lookup("plan", "m-1")).toEqual({ price: { input: 3, output: 15, cacheRead: 0.3 }, contextWindow: 100, images: false });
    expect(book.lookup("other", "m-2-20260101")).toEqual({ price: { input: 1, output: 2 } });
  });

  it("gives what a backend named precedence", () => {
    expect(book.enrich({ provider: "api", id: "m-1", name: "M", contextWindow: 50 })).toMatchObject({ contextWindow: 50, images: true });
  });

  it("gives a subscription model at no price in Pi's data the API's price", () => {
    const catalog = piNewThreadCatalog({ available: [models[0]!], subscription: (provider) => provider === "plan", book });
    expect(catalog.models[0]).toMatchObject({ login: "subscription", billing: "subscription", price: { input: 3, output: 15 } });
  });

  it("tells a local server and a free model from an API key", () => {
    expect(piBilling({ provider: "ollama", id: "q", baseUrl: "http://localhost:11434/v1" }, false)).toBe("local");
    expect(piBilling({ provider: "lm", id: "q", baseUrl: "http://127.0.0.1:1234" }, false)).toBe("local");
    expect(piBilling({ provider: "opencode", id: "free", baseUrl: "https://opencode.ai", cost: { input: 0, output: 0 } }, false)).toBe("free");
    expect(piBilling(models[1]!, false)).toBe("api-key");
    expect(piBilling(models[1]!, true)).toBe("subscription");
  });

  it("dates a model by its bare id where models.dev knows it, and says nothing otherwise", () => {
    const dated = new ModelPriceBook(() => models, (id) => (id === "m-1" ? "2026-01-15" : undefined));
    expect(dated.lookup("api", "m-1-20260101")).toMatchObject({ releasedAt: "2026-01-15" });
    expect(dated.enrich({ provider: "acme", id: "m-1[1m]", name: "M" })).toMatchObject({ releasedAt: "2026-01-15" });
    expect(piNewThreadCatalog({ available: [models[1]!], subscription: () => false, book: dated }).models[0]?.releasedAt).toBe("2026-01-15");
    expect(book.lookup("api", "m-2")).not.toHaveProperty("releasedAt");
  });
});
