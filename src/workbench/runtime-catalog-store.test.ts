import { describe, expect, it, vi } from "vitest";
import type { HostSnapshot, UiRuntimeCatalog } from "../shared/contracts";
import { createNewThreadDraft } from "./draft-store";
import { RuntimeCatalogStore, draftRuntimeSnapshot } from "./runtime-catalog-store";

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

describe("RuntimeCatalogStore", () => {
  it("asks the host once while an answer is fresh, and again when it is not", async () => {
    let now = 0;
    const load = vi.fn(async () => CATALOG);
    const store = new RuntimeCatalogStore(load, () => now);
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
    const store = new RuntimeCatalogStore(async (kind) => kind === "antigravity"
      ? { kind, models: [], thinkingLevels: {}, note: "Chosen after the start." }
      : kind === "gone" ? undefined : Promise.reject(new Error("no CLI")));
    for (const kind of ["antigravity", "gone", "broken"]) store.request(kind);
    await vi.waitFor(() => expect(store.get("broken")).toEqual({ status: "unavailable", message: "no CLI" }));
    expect(store.get("antigravity")).toEqual({ status: "unavailable", message: "Chosen after the start." });
    expect(store.get("gone")).toEqual({ status: "unavailable" });
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

  it("leaves the snapshot alone until the catalog is there", () => {
    expect(draftRuntimeSnapshot(SNAPSHOT, draft(), "codex", { status: "loading" })).toBe(SNAPSHOT);
    expect(draftRuntimeSnapshot(SNAPSHOT, draft(), "codex", undefined)).toBe(SNAPSHOT);
  });
});
