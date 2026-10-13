import { describe, expect, it } from "vitest";
import type { UiModel, UiRuntimeBackend } from "../../shared/contracts";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";
import { runtimeRow } from "./runtimes-table";

const models = (...providers: string[]) => providers.map((provider, index) => ({ provider, id: `m${index}`, name: `M${index}` }) as UiModel);
const ready = (...providers: string[]): RuntimeCatalogEntry => ({ status: "ready", catalog: { kind: "x", models: models(...providers), thinkingLevels: {} } });
const options = { isDefault: false, card: true };

describe("an entry of Settings → Runtimes", () => {
  it("calls Pi built in, with the providers its catalog names once each", () => {
    const row = runtimeRow({ kind: "pi", label: "Pi" }, ready("anthropic", "openai", "anthropic", "google"), { ...options, isDefault: true, card: false });
    expect(row.isDefault).toBe(true);
    expect(row.status).toEqual([]);
    expect(row.version).toEqual({ text: "Built in · agents, worktrees, per-tool approvals" });
    expect(row.providers).toEqual(["anthropic", "openai", "google"]);
    expect(row.actions).toEqual([]);
  });

  it("says a program is current, or that an update is out, and offers Update once it is behind", () => {
    const current: UiRuntimeBackend = { kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.49.0", latest: "0.49.0" } };
    expect(runtimeRow(current, ready("openai"), options)).toMatchObject({
      state: "current",
      status: [{ text: "Installed · up to date", tone: "success" }],
      version: { text: "0.49.0", tool: "codex" },
      actions: [],
    });
    const behind: UiRuntimeBackend = { ...current, version: { tool: "codex", installed: "0.48.2", latest: "0.49.0" } };
    expect(runtimeRow(behind, ready("openai"), options)).toMatchObject({
      state: "update",
      status: [{ text: "Update available", tone: "accent" }],
      version: { text: "0.48.2 → 0.49.0", tool: "codex" },
      actions: ["update"],
    });
  });

  it("puts a version the policy warns about before a newer release", () => {
    const backend: UiRuntimeBackend = { kind: "claude-code", label: "Claude Code", version: { tool: "claude", installed: "2.0.0", latest: "2.1.4", compatibility: { status: "broken" } } };
    expect(runtimeRow(backend, ready("anthropic"), options)).toMatchObject({ state: "broken", status: [{ text: "Version does not work", tone: "danger" }], actions: ["update"] });
  });

  it("offers Install, and nothing else, for a program that is not there, and only with a card to install it from", () => {
    const missing: RuntimeCatalogEntry = { status: "unavailable", reason: "not-installed" };
    const backend: UiRuntimeBackend = { kind: "cursor", label: "Cursor Agent", version: { tool: "cursor-agent" } };
    expect(runtimeRow(backend, missing, options)).toMatchObject({ state: "missing", status: [{ text: "Not installed", tone: "muted" }], version: { text: "Not found", tool: "cursor-agent" }, providers: [], actions: ["install"] });
    expect(runtimeRow(backend, missing, { ...options, card: false }).actions).toEqual([]);
  });

  it("says a runtime waits for a sign-in, and that its catalog is still on the way", () => {
    expect(runtimeRow({ kind: "grok", label: "Grok" }, { status: "unavailable", reason: "sign-in-required" }, options).status).toEqual([{ text: "Needs sign-in", tone: "warn" }]);
    expect(runtimeRow({ kind: "grok", label: "Grok" }, { status: "loading" }, options).status).toEqual([{ text: "Checking…", tone: "muted" }]);
    expect(runtimeRow({ kind: "grok", label: "Grok" }, { status: "unavailable", message: "The server did not start." }, options)).toMatchObject({ status: [{ text: "Unavailable", tone: "warn" }], note: "The server did not start." });
  });
});
