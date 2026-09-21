import { describe, expect, it } from "vitest";
import type { WorkbenchBuildResult } from "../shared/contracts";
import { reloadRouteFor } from "./use-workbench-reload";

const build = (overrides: Partial<WorkbenchBuildResult> = {}): WorkbenchBuildResult => ({
  ok: true, durationMs: 1, mainChanged: false, runtimeChanged: false, output: "", ...overrides,
});

describe("reloadRouteFor", () => {
  it("reloads only kits and the page when nothing else changed", () => {
    expect(reloadRouteFor(build())).toBe("extensions");
  });

  it("goes through the runtime when a kit's runtime half changed", () => {
    expect(reloadRouteFor(build({ runtimeChanged: true }))).toBe("runtime");
  });

  it("restarts when the main process changed, whatever else did", () => {
    expect(reloadRouteFor(build({ mainChanged: true }))).toBe("relaunch");
    expect(reloadRouteFor(build({ mainChanged: true, runtimeChanged: true }))).toBe("relaunch");
  });
});
