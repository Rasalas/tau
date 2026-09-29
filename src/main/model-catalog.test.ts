import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  SignedModelCatalog,
  catalogModelsFor,
  modelCatalogKeys,
  parseModelCatalog,
  withModelCatalog,
  withoutModelCatalog,
  type ModelCatalog,
} from "./model-catalog.js";
import { createPiModelRuntime, modelReleaseDate, useModelCatalog } from "./pi-model-runtime.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  useModelCatalog(undefined, tmpdir());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-model-catalog-"));
  directories.push(directory);
  return directory;
}

/** A throwaway key, never the release key. */
function signer(): { publicKey: string; sign(text: string): string; key: KeyObject } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    key: privateKey,
    publicKey: publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64"),
    sign: (text) => `${sign(null, Buffer.from(text, "utf8"), privateKey).toString("base64")}\n`,
  };
}

const SOL = {
  provider: "openai-codex",
  id: "gpt-6.1-sol",
  name: "GPT-6.1 Sol",
  like: "gpt-6-astra",
  contextWindow: 400_000,
  thinkingLevels: ["low", "medium", "high"],
  price: { input: 2, output: 10, cacheRead: 0.2 },
  since: "2026-09-29",
  source: "https://example.com/gpt-6-1",
};

function catalogText(revision: number, models: unknown[] = [SOL]): string {
  return `${JSON.stringify({ schema: 1, revision, models }, null, 2)}\n`;
}

function server(files: Record<string, string>): typeof fetch {
  return (async (url: string | URL | Request) => {
    const body = files[String(url)];
    return body === undefined ? new Response("", { status: 404 }) : new Response(body);
  }) as typeof fetch;
}

const CATALOG_URL = "https://example.test/catalog/models.json";

describe("parseModelCatalog", () => {
  it("takes the data it knows and refuses anything else", () => {
    expect(parseModelCatalog(catalogText(3)).models[0]).toMatchObject({ provider: "openai-codex", id: "gpt-6.1-sol", thinkingLevels: ["low", "medium", "high"] });
    expect(() => parseModelCatalog("{")).toThrow("not JSON");
    expect(() => parseModelCatalog(catalogText(0))).toThrow("revision");
    expect(() => parseModelCatalog(catalogText(1, [{ ...SOL, script: "rm -rf /" }]))).toThrow("unknown field script");
    expect(() => parseModelCatalog(catalogText(1, [{ ...SOL, source: "http://example.com" }]))).toThrow("https");
    expect(() => parseModelCatalog(catalogText(1, [{ ...SOL, price: { input: -1, output: 1 } }]))).toThrow("price");
    expect(() => parseModelCatalog(catalogText(1, [{ ...SOL, thinkingLevels: ["ludicrous"] }]))).toThrow("thinkingLevels");
    expect(() => parseModelCatalog(catalogText(1, [SOL, SOL]))).toThrow("twice");
  });
});

describe("SignedModelCatalog", () => {
  it("takes a signed catalog, keeps it on disk and reads it back offline", async () => {
    const keys = signer();
    const directory = await scratch();
    const file = join(directory, "model-catalog.json");
    const text = catalogText(2);
    const log = vi.fn();
    const online = new SignedModelCatalog({ keys: [keys.publicKey], file, url: CATALOG_URL, fetch: server({ [CATALOG_URL]: text, [`${CATALOG_URL}.sig`]: keys.sign(text) }), log });
    await expect(online.refresh()).resolves.toBe(true);
    expect(online.current()?.revision).toBe(2);
    const offline = new SignedModelCatalog({ keys: [keys.publicKey], file, url: CATALOG_URL, fetch: vi.fn(async () => { throw new Error("offline"); }), log });
    await offline.load();
    expect(offline.current()?.models.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
    await expect(offline.refresh(true)).resolves.toBe(false);
    expect(offline.current()?.revision).toBe(2);
  });

  it("ignores a catalog without a valid signature, one signed by another key, and an older revision", async () => {
    const keys = signer();
    const stranger = signer();
    const log = vi.fn();
    const newer = catalogText(5);
    const held = new SignedModelCatalog({ keys: [keys.publicKey], url: CATALOG_URL, fetch: server({ [CATALOG_URL]: newer, [`${CATALOG_URL}.sig`]: keys.sign(newer) }), log });
    await held.refresh();
    const tampered = catalogText(6).replace("GPT-6.1 Sol", "GPT-6.1 Sol (free)");
    for (const [text, signature] of [[tampered, keys.sign(catalogText(6))], [catalogText(7), stranger.sign(catalogText(7))], [catalogText(4), keys.sign(catalogText(4))]] as const) {
      const other = new SignedModelCatalog({ keys: [keys.publicKey], url: CATALOG_URL, fetch: server({ [CATALOG_URL]: text, [`${CATALOG_URL}.sig`]: signature }), log });
      Object.assign(other, { held: { catalog: held.current(), checkedAt: 0 } });
      await expect(other.refresh(true)).resolves.toBe(false);
      expect(other.current()?.revision).toBe(5);
    }
    expect(log.mock.calls.map((call) => String(call[1]))).toEqual(expect.arrayContaining([
      expect.stringContaining("not signed by Tau's release key"),
      expect.stringContaining("older than the held 5"),
    ]));
  });

  it("refuses a file on disk whose signature does not verify", async () => {
    const keys = signer();
    const directory = await scratch();
    const file = join(directory, "model-catalog.json");
    await writeFile(file, JSON.stringify({ version: 1, text: catalogText(9), signature: keys.sign(catalogText(1)), checkedAt: 0 }));
    const log = vi.fn();
    const feed = new SignedModelCatalog({ keys: [keys.publicKey], file, log });
    await feed.load();
    expect(feed.current()).toBeUndefined();
    expect(log).toHaveBeenCalledWith("model-catalog.disk-refused", expect.stringContaining("not signed"));
  });

  it("trusts a test catalog's own key only together with its own address", () => {
    expect(modelCatalogKeys({ TAU_MODEL_CATALOG_KEY: "abc" }, ["release"])).toEqual(["release"]);
    expect(modelCatalogKeys({ TAU_MODEL_CATALOG_KEY: "abc", TAU_MODEL_CATALOG_URL: "file:///tmp/models.json" }, ["release"])).toEqual(["abc"]);
  });
});

describe("the catalog in Pi", () => {
  const catalog: ModelCatalog = parseModelCatalog(catalogText(1, [SOL, { provider: "openai-codex", id: "gpt-6-astra", name: "Not Pi's Astra", price: { input: 99, output: 99 } }]));

  it("adds a model Pi does not know, built on the one it names, and never replaces Pi's own", async () => {
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    const codex = runtime.getProvider("openai-codex")!;
    const added = catalogModelsFor(codex, catalog);
    expect(added.map((model) => model.id)).toEqual(["gpt-6.1-sol"]);
    const astra = codex.getModels().find((model) => model.id === "gpt-6-astra")!;
    expect(added[0]).toMatchObject({ api: astra.api, baseUrl: astra.baseUrl, name: "GPT-6.1 Sol", contextWindow: 400_000, maxTokens: astra.maxTokens, cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 0 } });
    expect(added[0]!.thinkingLevelMap).toMatchObject({ minimal: null, xhigh: null, max: null, medium: astra.thinkingLevelMap?.medium });
    const wrapped = withModelCatalog(codex, catalog)!;
    expect(wrapped.getModels().filter((model) => model.id === "gpt-6-astra")).toEqual([astra]);
    expect(withoutModelCatalog(wrapped)).toBe(codex);
    expect(withModelCatalog(runtime.getProvider("anthropic")!, catalog)).toBeUndefined();
  });

  it("reaches runtimes built before and after it arrives, and leaves a provider models.json shapes alone", async () => {
    vi.stubEnv("PI_OFFLINE", "1");
    const agentDir = await scratch();
    const before = await createPiModelRuntime(agentDir);
    expect(before.getModel("openai-codex", "gpt-6.1-sol")).toBeUndefined();
    useModelCatalog(catalog, agentDir);
    expect(before.getModel("openai-codex", "gpt-6.1-sol")).toMatchObject({ name: "GPT-6.1 Sol" });
    expect(modelReleaseDate("gpt-6.1-sol")).toBe("2026-09-29");
    const after = await createPiModelRuntime(agentDir);
    expect(after.getModel("openai-codex", "gpt-6.1-sol")).toMatchObject({ name: "GPT-6.1 Sol" });
    expect(after.getModel("openai-codex", "gpt-6-astra")?.name).toBe("GPT-6 Astra");
    const configured = await scratch();
    await writeFile(join(configured, "models.json"), JSON.stringify({ providers: { "openai-codex": { modelOverrides: {} } } }));
    const own = await createPiModelRuntime(configured);
    expect(own.getModel("openai-codex", "gpt-6.1-sol")).toBeUndefined();
  });
});

describe("catalog/models.json", () => {
  it("parses with the host's own parser, and each entry adds to a provider Pi has, after a model it has", async () => {
    const catalog = parseModelCatalog(await readFile(new URL("../../catalog/models.json", import.meta.url), "utf8"));
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, refreshOnCreate: false });
    for (const entry of catalog.models) {
      const provider = runtime.getProvider(entry.provider);
      expect(provider, entry.provider).toBeDefined();
      if (entry.like) expect(provider!.getModels().some((model) => model.id === entry.like), `${entry.provider}/${entry.like}`).toBe(true);
    }
  });
});

