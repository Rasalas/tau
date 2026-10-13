import { describe, expect, it } from "vitest";
import type { HostSnapshot, UiModel, UiRuntimeCatalog } from "../shared/contracts";
import { catalogEntry, type RuntimeCatalogEntry } from "../workbench/runtime-catalog-store";
import { chosenNewThreadRuntime, effectiveNewThreadRuntime, newThreadSetup, offeredBackends, rememberedNewThreadSelection, runtimeStart } from "./new-thread-runtime";

const snapshot = {
  runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }],
  defaultBackendKind: "acme",
} as HostSnapshot;

describe("the runtime of a new thread", () => {
  it("is the client's choice when the host offers it", () => {
    expect(chosenNewThreadRuntime("acme", snapshot)).toBe("acme");
    expect(effectiveNewThreadRuntime("pi", snapshot)).toBe("pi");
  });

  it("falls back to the host's default when the choice is not installed or absent", () => {
    expect(chosenNewThreadRuntime("gone", snapshot)).toBeUndefined();
    expect(effectiveNewThreadRuntime("gone", snapshot)).toBe("acme");
    expect(chosenNewThreadRuntime(undefined, snapshot)).toBeUndefined();
    expect(effectiveNewThreadRuntime(undefined, undefined)).toBe("pi");
  });
});

describe("the runtime of a new thread in a project that turned runtimes off", () => {
  const marked = (...off: string[]) => ({
    runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }, { kind: "other", label: "Other" }].map((backend) => off.includes(backend.kind) ? Object.assign({ disabled: true }, backend) : backend),
    defaultBackendKind: "acme",
  }) as HostSnapshot;

  it("does not take a choice the project turned off, and falls back to the default", () => {
    expect(chosenNewThreadRuntime("other", marked("other"))).toBeUndefined();
    expect(effectiveNewThreadRuntime("other", marked("other"))).toBe("acme");
    expect(effectiveNewThreadRuntime("pi", marked("other"))).toBe("pi");
  });

  it("stands in the first runtime that is on for a default the project turned off", () => {
    expect(effectiveNewThreadRuntime(undefined, marked("acme"))).toBe("pi");
    expect(effectiveNewThreadRuntime("acme", marked("acme", "pi"))).toBe("other");
  });

  it("keeps the default when every runtime is off, so the host can say why", () => {
    expect(effectiveNewThreadRuntime(undefined, marked("acme", "pi", "other"))).toBe("acme");
    expect(offeredBackends(marked("acme", "pi").runtimeBackends).map((backend) => backend.kind)).toEqual(["other"]);
  });
});

describe("a new thread's remembered model", () => {
  const old = { provider: "openai", id: "old", name: "Old" };
  const latest = { provider: "openai", id: "latest", name: "Latest" };
  const catalog: UiRuntimeCatalog = { kind: "codex@work", models: [old, latest], model: old, thinkingLevels: { latest: ["low", "high"] } };

  it("takes the newest available choice and a supported level for the exact runtime account", () => {
    const recent = ["codex:openai/old", "openai/old", "codex@work:openai/gone", "codex@work:openai/latest", "codex@work:openai/old"];
    expect(rememberedNewThreadSelection(catalog, recent, { "codex@work:openai/latest": "high" }))
      .toEqual({ runtime: "codex@work", model: latest, thinkingLevel: "high" });
    expect(rememberedNewThreadSelection(catalog, recent, { "codex@work:openai/latest": "max" }))
      .toEqual({ runtime: "codex@work", model: latest });
  });

  it("falls back to the catalog default when remembered models are gone", () => {
    expect(rememberedNewThreadSelection(catalog, ["codex@work:openai/gone"], {})).toEqual({ runtime: "codex@work", model: old });
    expect(rememberedNewThreadSelection({ ...catalog, model: undefined }, ["codex@work:openai/gone"], {})).toBeUndefined();
  });

  it("uses Pi's provider-qualified levels and leaves runtimes without history alone", () => {
    const pi = { ...catalog, kind: "pi", thinkingLevels: { "openai/latest": ["medium", "high"] } };
    expect(rememberedNewThreadSelection(pi, ["codex@work:openai/old", "openai/latest"], { "openai/latest": "high" }))
      .toEqual({ runtime: "pi", model: latest, thinkingLevel: "high" });
    expect(rememberedNewThreadSelection(catalog, ["openai/latest"], {})).toBeUndefined();
  });
});

describe("the runtime of a new thread by what is ready", () => {
  const model: UiModel = { provider: "acme", id: "one", name: "One" };
  const host = {
    runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme" }, { kind: "other", label: "Other" }],
  } as HostSnapshot;
  const ready = (kind: string): UiRuntimeCatalog => ({ kind, models: [model], thinkingLevels: {} });
  const signedOut = (kind: string): UiRuntimeCatalog => ({ kind, models: [], thinkingLevels: {}, status: "sign-in-required", note: "Sign in first." });
  const noProvider: UiRuntimeCatalog = { kind: "pi", models: [], thinkingLevels: {} };
  const held = (...catalogs: UiRuntimeCatalog[]): ReadonlyMap<string, RuntimeCatalogEntry> => new Map(catalogs.map((catalog) => [catalog.kind, catalogEntry(catalog)]));

  it("starts on the first runtime that is ready when the default cannot run a thread", () => {
    const catalogs = held(noProvider, signedOut("acme"), ready("other"));
    expect(effectiveNewThreadRuntime(undefined, host, catalogs)).toBe("other");
    // The host is told too: a thread is created on the runtime the prompt was prepared for.
    expect(chosenNewThreadRuntime(undefined, host, catalogs)).toBe("other");
  });

  it("keeps the default while it is ready, and while nothing is known yet", () => {
    expect(effectiveNewThreadRuntime(undefined, host, held(ready("pi"), ready("acme")))).toBe("pi");
    expect(chosenNewThreadRuntime(undefined, host, held(ready("pi"), ready("acme")))).toBeUndefined();
    expect(effectiveNewThreadRuntime(undefined, host, held())).toBe("pi");
    expect(effectiveNewThreadRuntime(undefined, host, held(ready("acme")))).toBe("pi");
    expect(effectiveNewThreadRuntime(undefined, host, new Map([["pi", { status: "loading" }], ["acme", catalogEntry(ready("acme"))]]))).toBe("pi");
  });

  it("leaves a runtime the client chose alone, ready or not", () => {
    const catalogs = held(noProvider, signedOut("acme"), ready("other"));
    expect(effectiveNewThreadRuntime("acme", host, catalogs)).toBe("acme");
    expect(chosenNewThreadRuntime("acme", host, catalogs)).toBe("acme");
  });

  it("does not stand in a runtime the project turned off", () => {
    const off = { runtimeBackends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme", disabled: true }, { kind: "other", label: "Other" }] } as HostSnapshot;
    expect(effectiveNewThreadRuntime(undefined, off, held(noProvider, ready("acme"), ready("other")))).toBe("other");
  });

  it("reads a runtime's catalog the way the host's readiness does", () => {
    expect(runtimeStart("pi", catalogEntry(noProvider))).toBe("signed-out");
    expect(runtimeStart("pi", catalogEntry(ready("pi")))).toBe("ready");
    // A runtime that names its models only once a thread runs can start one.
    expect(runtimeStart("acme", catalogEntry({ kind: "acme", models: [], thinkingLevels: {} }))).toBe("ready");
    expect(runtimeStart("acme", catalogEntry({ kind: "acme", models: [], thinkingLevels: {}, status: "not-installed" }))).toBe("not-installed");
    expect(runtimeStart("acme", catalogEntry({ kind: "acme", models: [], thinkingLevels: {}, status: "unavailable", note: "Timed out." }))).toBe("unavailable");
    expect(runtimeStart("acme", { status: "loading" })).toBeUndefined();
    expect(runtimeStart("acme", undefined)).toBeUndefined();
  });

  it("says what a draft waits for, only when the catalogs state it", () => {
    const catalogs = held(noProvider, signedOut("acme"), ready("other"));
    expect(newThreadSetup("pi", host, catalogs)).toEqual({ state: "signed-out", backend: { kind: "pi", label: "Pi" } });
    expect(newThreadSetup("acme", host, catalogs)).toEqual({ state: "signed-out", backend: { kind: "acme", label: "Acme" } });
    expect(newThreadSetup("other", host, catalogs)).toBeUndefined();
    expect(newThreadSetup("pi", host, held())).toBeUndefined();
    expect(newThreadSetup("pi", host, undefined)).toBeUndefined();
  });

  it("trusts the models of the thread on screen over a catalog that says its runtime has none", () => {
    const live = { ...host, sessionId: "thread", backendKind: "pi", models: [model] } as HostSnapshot;
    const catalogs = held(noProvider, ready("acme"));
    expect(effectiveNewThreadRuntime(undefined, live, catalogs)).toBe("pi");
    expect(newThreadSetup("pi", live, catalogs)).toBeUndefined();
    // A thread with no model says nothing for its runtime.
    expect(effectiveNewThreadRuntime(undefined, { ...live, models: [] } as HostSnapshot, catalogs)).toBe("acme");
  });

  it("says no provider is set up when no runtime the project offers can start a thread", () => {
    const notInstalled: UiRuntimeCatalog = { kind: "other", models: [], thinkingLevels: {}, status: "not-installed" };
    expect(newThreadSetup("pi", host, held(noProvider, signedOut("acme"), notInstalled))).toEqual({ state: "none" });
    // One that is still unknown, or only failed to answer, is not "none".
    expect(newThreadSetup("pi", host, held(noProvider, signedOut("acme")))).toMatchObject({ state: "signed-out" });
    // A Pi-only host: Pi without a provider is all there is.
    expect(newThreadSetup("pi", { runtimeBackends: [{ kind: "pi", label: "Pi" }] } as HostSnapshot, held(noProvider))).toEqual({ state: "none" });
  });
});
