import { describe, expect, it } from "vitest";
import { pickerViews, runtimeStatus } from "./model-picker-rail";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";

const backends = [{ kind: "pi", label: "Pi" }, { kind: "codex", label: "Codex" }, { kind: "claude-code", label: "Claude Code" }];
const ready: RuntimeCatalogEntry = { status: "ready", catalog: { kind: "codex", models: [{ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }], thinkingLevels: {} } };

describe("the picker's left column", () => {
  it("lists Favourites, Recent once something was chosen, then every runtime in the host's order", () => {
    const views = pickerViews({ catalogRuntime: "pi", backends, catalogs: new Map([["codex", ready]]), recent: true });
    expect(views.map((entry) => entry.key)).toEqual(["favourites", "recent", "runtime:pi", "runtime:codex", "runtime:claude-code"]);
    expect(pickerViews({ catalogRuntime: "pi", backends, catalogs: new Map(), recent: false }).map((entry) => entry.key)[1]).toBe("runtime:pi");
  });

  it("adds the catalog's own runtime on a host that lists none", () => {
    expect(pickerViews({ catalogRuntime: undefined, backends: undefined, catalogs: new Map(), recent: false }).map((entry) => entry.key)).toEqual(["favourites", "runtime:pi"]);
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
