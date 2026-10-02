import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiRuntimeCatalog } from "../shared/contracts";
import { createNewThreadDraft } from "./draft-store";
import { RuntimeCatalogStore, draftRuntimeSnapshot, type RuntimeCatalogPort } from "./runtime-catalog-store";

const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" };
const sol = { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
const CATALOG: UiRuntimeCatalog = {
  kind: "codex",
  models: [sol, luna],
  model: luna,
  thinkingLevels: { "gpt-5.6-luna": ["default (low)", "low", "medium"], "gpt-5.6-sol": ["default (medium)", "low", "high"] },
  runtimeCapabilities: { skillInvocationDialect: "codex", fileAttachments: true },
};
const SNAPSHOT = {
  sessionId: "pi-thread", cwd: "/repo", backendKind: "pi", models: [{ provider: "anthropic", id: "haiku", name: "Haiku" }],
  model: { provider: "anthropic", id: "haiku", name: "Haiku" }, thinkingLevel: "off", thinkingLevels: ["off", "high"],
  contextUsage: { tokens: 10, contextWindow: 100, percent: 10 }, messages: [], activeTools: [], allTools: [], isStreaming: false,
} as unknown as HostSnapshot;
const draft = () => createNewThreadDraft({ projectPath: "/repo", projectName: "repo" });

const port = (runtimeCatalog: RuntimeCatalogPort["runtimeCatalog"], runtimeCatalogs: RuntimeCatalogPort["runtimeCatalogs"] = async () => []): RuntimeCatalogPort => ({ runtimeCatalog, runtimeCatalogs });

describe("RuntimeCatalogStore", () => {
  it("asks the host once while an answer is fresh, and again when it is not", async () => {
    let now = 0;
    const load = vi.fn(async () => CATALOG);
    const store = new RuntimeCatalogStore(port(load), () => now);
    const seen = vi.fn();
    store.subscribe(seen);
    store.request("codex");
    store.request("codex");
    expect(store.get("codex")).toEqual({ status: "loading" });
    await vi.waitFor(() => expect(store.get("codex")).toEqual({ status: "ready", catalog: CATALOG }));
    store.request("codex");
    expect(load).toHaveBeenCalledTimes(1);
    now += 3 * 60 * 1000;
    store.request("codex");
    expect(load).toHaveBeenCalledTimes(2);
    expect(seen).toHaveBeenCalled();
  });

  it("calls a runtime that cannot say, or fails to, unavailable with its reason", async () => {
    const store = new RuntimeCatalogStore(port(async (kind) => kind === "antigravity"
      ? { kind, models: [], thinkingLevels: {}, note: "Chosen after the start." }
      : kind === "gone" ? undefined : Promise.reject(new Error("no CLI"))));
    for (const kind of ["antigravity", "gone", "broken"]) store.request(kind);
    await vi.waitFor(() => expect(store.get("broken")).toEqual({ status: "unavailable", message: "no CLI" }));
    expect(store.get("antigravity")).toMatchObject({ status: "unavailable", message: "Chosen after the start." });
    expect(store.get("gone")).toEqual({ status: "unavailable" });
  });

  it("takes every catalog the host holds when a picker opens, then only what the store lacks", async () => {
    const pi = { kind: "pi", models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", price: { input: 0.2, output: 1.2 } }], thinkingLevels: {}, checkedAt: 5 };
    const list = vi.fn(async (_revalidate: boolean, known: Record<string, number>) => [{ ...CATALOG, checkedAt: 7 }, pi].filter((catalog) => known[catalog.kind] !== catalog.checkedAt));
    const store = new RuntimeCatalogStore(port(vi.fn(), list));
    const views = [store.all()];
    store.subscribe(() => views.push(store.all()));
    store.refresh();
    await vi.waitFor(() => expect(store.get("pi")).toEqual({ status: "ready", catalog: pi }));
    expect(list).toHaveBeenLastCalledWith(true, {});
    expect(views.at(-1)?.get("codex")).toMatchObject({ status: "ready" });
    expect(views.at(-2)).not.toBe(views.at(-1));

    store.refresh();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    expect(list).toHaveBeenLastCalledWith(true, { codex: 7, pi: 5 });
  });

  it("follows what the host publishes, and a missing CLI is a reason, not an empty list", () => {
    const store = new RuntimeCatalogStore(port(vi.fn()));
    store.apply({ kind: "codex", models: [], thinkingLevels: {}, status: "not-installed", note: "The Codex CLI is not installed." });
    expect(store.get("codex")).toMatchObject({ status: "unavailable", reason: "not-installed", message: "The Codex CLI is not installed." });
    // Models named before a failed refresh are still offered; the catalog says why they may be old.
    store.apply({ ...CATALOG, status: "unavailable", note: "timed out" });
    expect(store.get("codex")).toMatchObject({ status: "ready", catalog: { status: "unavailable", note: "timed out" } });
  });
});

describe("draftRuntimeSnapshot", () => {
  it("shows the runtime's catalog, starting where the runtime would, without the thread on screen's usage", () => {
    const shown = draftRuntimeSnapshot(SNAPSHOT, draft(), "codex", { status: "ready", catalog: CATALOG });
    expect(shown).toMatchObject({ backendKind: "codex", models: [sol, luna], model: luna, thinkingLevel: "default (low)", thinkingLevels: ["default (low)", "low", "medium"], runtimeCapabilities: CATALOG.runtimeCapabilities });
    expect(shown.contextUsage).toBeUndefined();
  });

  it("applies what the draft chose for this runtime, and ignores a choice made for another", () => {
    const chosen = draftRuntimeSnapshot(SNAPSHOT, { ...draft(), model: sol, thinkingLevel: "high", selectionRuntime: "codex" }, "codex", { status: "ready", catalog: CATALOG });
    expect(chosen).toMatchObject({ model: sol, thinkingLevel: "high", thinkingLevels: ["default (medium)", "low", "high"] });
    const forPi = draftRuntimeSnapshot(SNAPSHOT, { ...draft(), model: sol, thinkingLevel: "high" }, "codex", { status: "ready", catalog: CATALOG });
    expect(forPi).toMatchObject({ model: luna, thinkingLevel: "default (low)" });
  });

  it("gives a draft on the thread's own runtime the levels of the model it chose, from Pi's default (K137)", () => {
    const pi: UiRuntimeCatalog = { kind: "pi", models: [luna, sol], model: luna, thinkingLevels: { "openai/gpt-5.6-luna": ["off", "low", "medium", "high"] } };
    const onFake = { ...SNAPSHOT, model: { provider: "tau-fake", id: "fake-1", name: "Fake 1" }, thinkingLevels: ["off"] } as HostSnapshot;
    const shown = draftRuntimeSnapshot(onFake, { ...draft(), model: luna }, "pi", { status: "ready", catalog: pi });
    expect(shown).toMatchObject({ backendKind: "pi", models: onFake.models, model: luna, thinkingLevel: "medium", thinkingLevels: ["off", "low", "medium", "high"] });
    expect(draftRuntimeSnapshot(onFake, { ...draft(), model: luna, thinkingLevel: "high" }, "pi", { status: "ready", catalog: pi }).thinkingLevel).toBe("high");
    // No model chosen, or one the catalog does not know: the thread's levels stand.
    expect(draftRuntimeSnapshot(onFake, draft(), "pi", { status: "ready", catalog: pi })).toBe(onFake);
    expect(draftRuntimeSnapshot(SNAPSHOT, { ...draft(), model: SNAPSHOT.model! }, "pi", { status: "ready", catalog: pi })).toBe(SNAPSHOT);
  });

  it("leaves the snapshot alone until the catalog is there", () => {
    expect(draftRuntimeSnapshot(SNAPSHOT, draft(), "codex", { status: "loading" })).toBe(SNAPSHOT);
    expect(draftRuntimeSnapshot(SNAPSHOT, draft(), "codex", undefined)).toBe(SNAPSHOT);
  });
});
