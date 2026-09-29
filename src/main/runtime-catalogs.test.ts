import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRuntimeCatalog } from "../shared/contracts.js";
import type { HostRuntimeNewThreadCatalog } from "./host-extensions.js";
import { ModelPriceBook } from "./model-price-book.js";
import { RuntimeCatalogs, decodeCatalogs, type RuntimeCatalogSource, type RuntimeCatalogsOptions } from "./runtime-catalogs.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratchFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-runtime-catalogs-"));
  directories.push(directory);
  return join(directory, "runtime-catalogs.json");
}

const LUNA = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" as const };
const ANSWER: HostRuntimeNewThreadCatalog = { models: [LUNA], model: LUNA, thinkingLevels: { "gpt-5.6-luna": ["default", "low"] } };
const book = new ModelPriceBook(() => [{ provider: "openai", id: "gpt-5.6-luna", cost: { input: 0.2, output: 1.2 }, contextWindow: 272_000 }]);

function source(load: RuntimeCatalogSource["load"], kind = "codex", owner: object = {}): RuntimeCatalogSource {
  return { kind, owner, capabilities: { skillInvocationDialect: "codex" }, load };
}

function catalogs(sources: () => readonly RuntimeCatalogSource[], options: Partial<RuntimeCatalogsOptions> = {}) {
  const published: UiRuntimeCatalog[] = [];
  let now = 1_000_000;
  const cache = new RuntimeCatalogs({
    sources,
    priceBook: async () => book,
    publish: (catalog) => published.push(catalog),
    automatic: false,
    log: () => undefined,
    now: () => now,
    ...options,
  });
  return { cache, published, advance: (ms: number) => { now += ms; } };
}

describe("RuntimeCatalogs", () => {
  it("asks a runtime once, fills in Pi's prices and publishes the catalog", async () => {
    const load = vi.fn(async () => ANSWER);
    const { cache, published } = catalogs(() => [source(load)]);
    const [first, second] = await Promise.all([cache.get("codex"), cache.get("codex")]);
    expect(load).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first).toMatchObject({
      kind: "codex",
      models: [{ ...LUNA, price: { input: 0.2, output: 1.2 }, contextWindow: 272_000 }],
      runtimeCapabilities: { skillInvocationDialect: "codex" },
      checkedAt: 1_000_000,
    });
    expect(published).toHaveLength(1);
    await expect(cache.get("gone")).resolves.toBeUndefined();
  });

  it("asks one runtime again at once when its sign-in changed, however fresh its answer", async () => {
    let answer: HostRuntimeNewThreadCatalog = { models: [], thinkingLevels: {}, status: "sign-in-required", note: "Sign in first." };
    const load = vi.fn(async () => answer);
    const { cache, published } = catalogs(() => [source(load)]);
    await cache.get("codex");
    answer = ANSWER;
    cache.recheck("codex");
    cache.recheck("nobody");
    await vi.waitFor(() => expect(published.at(-1)).toMatchObject({ kind: "codex", models: [{ id: "gpt-5.6-luna" }] }));
    expect(published.at(-1)?.status).toBeUndefined();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("serves what it holds at once and asks again behind it once the answer is old, publishing only a change", async () => {
    let answer = ANSWER;
    const load = vi.fn(async () => answer);
    const codex = source(load);
    const { cache, published, advance } = catalogs(() => [codex]);
    await cache.get("codex");
    await cache.list(true);
    expect(load).toHaveBeenCalledTimes(1);

    advance(11 * 60_000);
    await expect(cache.list(true)).resolves.toMatchObject([{ kind: "codex", checkedAt: 1_000_000 }]);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
    // The same answer: nothing published, nothing sent to a client that holds it.
    await cache.get("codex");
    expect(published).toHaveLength(1);
    await expect(cache.list(true, { codex: 1_000_000 })).resolves.toEqual([]);
    expect(load).toHaveBeenCalledTimes(2);

    advance(11 * 60_000);
    answer = { ...ANSWER, models: [LUNA, { ...LUNA, id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }] };
    await cache.list(true);
    await vi.waitFor(() => expect(published).toHaveLength(2));
    expect(published[1]!.models.map((model) => model.id)).toEqual(["gpt-5.6-luna", "gpt-5.6-sol"]);
    await expect(cache.list(false, { codex: 1_000_000 })).resolves.toHaveLength(1);
  });

  it("asks a runtime registered anew even while the old answer is fresh", async () => {
    const load = vi.fn(async () => ANSWER);
    let current = source(load);
    const { cache } = catalogs(() => [current]);
    await cache.get("codex");
    current = source(load);
    await cache.list(true);
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
  });

  it("asks again at once when the program behind the answer changed, across a restart too", async () => {
    let key = "codex:1:100";
    let answer: HostRuntimeNewThreadCatalog = ANSWER;
    const load = vi.fn(async () => answer);
    const changed: string[] = [];
    const file = await scratchFile();
    const owner = {};
    const withKey = (): RuntimeCatalogSource => ({ ...source(load, "codex", owner), programKey: async () => key });
    const first = catalogs(() => [withKey()], { file, programChanged: (kind) => changed.push(kind) });
    await first.cache.get("codex");
    await first.cache.list(true);
    expect(load).toHaveBeenCalledTimes(1);
    key = "codex:2:200";
    answer = { ...ANSWER, models: [...ANSWER.models, { provider: "openai", id: "gpt-6.1-sol", name: "GPT-6.1 Sol" }] };
    await expect(first.cache.get("codex")).resolves.toMatchObject({ models: [{ id: "gpt-5.6-luna" }, { id: "gpt-6.1-sol" }] });
    expect(changed).toEqual(["codex"]);
    await first.cache.flush();
    key = "codex:3:300";
    const second = catalogs(() => [withKey()], { file });
    await second.cache.list(true);
    // The ask the listing started is the one a recheck joins.
    await second.cache.recheck("codex");
    await second.cache.flush();
    expect(load).toHaveBeenCalledTimes(3);
  });

  it("answers from disk after a restart without asking the runtime", async () => {
    const file = await scratchFile();
    const first = catalogs(() => [source(async () => ANSWER)], { file });
    await first.cache.get("codex");
    await vi.waitFor(async () => expect(decodeCatalogs(JSON.parse(await readFile(file, "utf8")))).toHaveLength(1));

    const load = vi.fn(async () => ANSWER);
    const second = catalogs(() => [source(load)], { file });
    await expect(second.cache.list()).resolves.toMatchObject([{ kind: "codex", models: [{ id: "gpt-5.6-luna", price: { input: 0.2 } }] }]);
    expect(load).not.toHaveBeenCalled();
    // A runtime that is no longer registered is not served.
    const none = catalogs(() => [], { file });
    await expect(none.cache.list()).resolves.toEqual([]);
  });

  it("keeps the provider's id behind an alias for the host, across a restart, and never serves it", async () => {
    const file = await scratchFile();
    const HAIKU = { provider: "anthropic", id: "haiku", name: "Haiku 4.5", billing: "subscription" as const, apiModelId: "claude-haiku-4-5" };
    const first = catalogs(() => [source(async () => ({ models: [HAIKU], thinkingLevels: {} }), "claude-code")], { file });
    const served = await first.cache.get("claude-code");
    expect(served?.models[0]).not.toHaveProperty("apiModelId");
    expect(first.published[0]?.models[0]).not.toHaveProperty("apiModelId");
    await expect(first.cache.onHand()).resolves.toMatchObject([{ kind: "claude-code", models: [{ id: "haiku", apiModelId: "claude-haiku-4-5" }] }]);
    await vi.waitFor(async () => expect(decodeCatalogs(JSON.parse(await readFile(file, "utf8")))).toHaveLength(1));

    const second = catalogs(() => [source(async () => ANSWER, "claude-code")], { file });
    await expect(second.cache.onHand()).resolves.toMatchObject([{ models: [{ id: "haiku", apiModelId: "claude-haiku-4-5" }] }]);
    expect((await second.cache.list())[0]?.models[0]).not.toHaveProperty("apiModelId");
  });

    it("serves a catalog from a file without provider ids and asks the runtime again behind it", async () => {
    const file = await scratchFile();
    await writeFile(file, JSON.stringify({ version: 1, catalogs: [{ kind: "codex", models: [LUNA], thinkingLevels: {}, checkedAt: 999_000 }], askedAt: { codex: 999_000 } }));
    const load = vi.fn(async () => ANSWER);
    const { cache } = catalogs(() => [source(load)], { file });
    await expect(cache.get("codex")).resolves.toMatchObject({ models: [{ id: "gpt-5.6-luna" }] });
    await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
    await vi.waitFor(async () => expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ version: 2 }));
  });

    it("drops what the file holds that it cannot read", async () => {
    const file = await scratchFile();
    await writeFile(file, JSON.stringify({ version: 1, catalogs: [{ kind: "codex", models: [{ provider: "openai" }, LUNA], thinkingLevels: { x: ["a", 3] }, status: "bogus" }, { models: [] }] }));
    const { cache } = catalogs(() => [source(async () => ANSWER)], { file });
    await expect(cache.list()).resolves.toEqual([{ kind: "codex", models: [LUNA], thinkingLevels: { x: ["a"] }, runtimeCapabilities: { skillInvocationDialect: "codex" } }]);
  });

  it("says why a runtime cannot run instead of an empty list, and keeps the models it named when asking fails", async () => {
    let fail: Error | undefined;
    const answers: Record<string, HostRuntimeNewThreadCatalog> = {
      missing: { models: [LUNA], thinkingLevels: {}, status: "not-installed", note: "The CLI is not installed." },
      signedOut: { models: [], thinkingLevels: {}, status: "sign-in-required", note: "Sign in first." },
    };
    const flaky = source(async () => { if (fail) throw fail; return ANSWER; }, "flaky");
    const all = [source(async () => answers.missing, "missing"), source(async () => answers.signedOut, "signedOut"), flaky, source(async () => { throw new Error("no answer"); }, "broken")];
    const { cache, advance } = catalogs(() => all);
    await expect(cache.get("missing")).resolves.toMatchObject({ models: [], status: "not-installed", note: "The CLI is not installed." });
    await expect(cache.get("signedOut")).resolves.toMatchObject({ models: [], status: "sign-in-required" });
    await expect(cache.get("broken")).resolves.toMatchObject({ models: [], status: "unavailable", note: "no answer" });

    await cache.get("flaky");
    fail = new Error("probe timed out");
    advance(11 * 60_000);
    await cache.get("flaky");
    await vi.waitFor(async () => expect(await cache.get("flaky")).toMatchObject({ models: [{ id: "gpt-5.6-luna" }], status: "unavailable", note: "probe timed out" }));
  });

  it("gives up on a runtime that does not answer", async () => {
    const { cache } = catalogs(() => [source(() => new Promise(() => undefined))], { timeoutMs: 10 });
    await expect(cache.get("codex")).resolves.toMatchObject({ status: "unavailable", note: expect.stringContaining("did not name its models") });
  });

  it("asks every runtime in the background after start-up only when told to, and not again while the disk's answer is recent", async () => {
    const first = vi.fn(async () => ANSWER);
    const second = vi.fn(async () => ANSWER);
    const idle = catalogs(() => [source(first)], { startDelayMs: 0 });
    idle.cache.start();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first).not.toHaveBeenCalled();

    const file = await scratchFile();
    const both = [source(first), source(second, "agent-sdk")];
    const warm = catalogs(() => both, { automatic: true, startDelayMs: 0, file });
    warm.cache.start();
    await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1));
    expect(first).toHaveBeenCalledTimes(1);
    await warm.cache.flush();
    warm.cache.dispose();

    const again = catalogs(() => both, { automatic: true, startDelayMs: 0, file });
    again.cache.start();
    await expect(again.cache.list()).resolves.toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first).toHaveBeenCalledTimes(1);
    again.cache.dispose();
  });
});
