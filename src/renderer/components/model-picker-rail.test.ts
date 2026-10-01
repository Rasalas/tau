import { describe, expect, it } from "vitest";
import { pickerRuntimes, pickerViews, runtimeStatus } from "./model-picker-rail";
import { providerLabel } from "./ProviderIconStack";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";

const backends = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }, { kind: "claude-code", label: "Claude Code" }];
const ready: RuntimeCatalogEntry = { status: "ready", catalog: { kind: "codex", models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }], thinkingLevels: {} } };

describe("the picker's rail", () => {
  it("lists Favourites, Recent, the makers in their order and then the runtimes that list no models", () => {
    const runtimes = pickerRuntimes("pi", backends, new Map([["codex", ready]]));
    const views = pickerViews(["opencode", "anthropic", "openai", "anthropic", "acme"], runtimes, providerLabel);
    expect(views.map((entry) => entry.key)).toEqual(["favourites", "recent", "maker:openai", "maker:anthropic", "maker:acme", "maker:opencode", "runtime:claude-code"]);
  });

  it("adds the catalog's own runtime on a host that lists none", () => {
    expect(pickerRuntimes(undefined, undefined, new Map()).map((entry) => [entry.backend.kind, entry.listed])).toEqual([["pi", true]]);
  });

  it("gives each runtime a status: ready, update, loading, sign-in, not installed", () => {
    expect(runtimeStatus(backends[1]!, ready, false)).toEqual({ status: "ready", listed: true });
    expect(runtimeStatus({ ...backends[1]!, version: { tool: "codex", installed: "1.0.0", latest: "1.1.0" } }, ready, false).status).toBe("update");
    expect(runtimeStatus(backends[1]!, { status: "loading" }, false)).toEqual({ status: "loading", listed: false });
    expect(runtimeStatus(backends[1]!, { status: "unavailable", reason: "sign-in-required" }, false).status).toBe("sign-in");
    expect(runtimeStatus(backends[1]!, { status: "unavailable", reason: "not-installed" }, false).status).toBe("not-installed");
    expect(runtimeStatus(backends[1]!, undefined, false)).toEqual({ status: "unlisted", listed: false });
    // The catalog on hand is listed whatever the host's cache says.
    expect(runtimeStatus(backends[0]!, undefined, true)).toEqual({ status: "ready", listed: true });
  });
});
