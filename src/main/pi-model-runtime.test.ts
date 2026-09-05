import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createPiModelRuntime } from "./pi-model-runtime.js";

afterEach(() => vi.restoreAllMocks());

describe("createPiModelRuntime", () => {
  it("refreshes remote model catalogs while retaining Pi's persistent cache", async () => {
    const runtime = {} as ModelRuntime;
    const create = vi.spyOn(ModelRuntime, "create").mockResolvedValue(runtime);

    await expect(createPiModelRuntime("/agent")).resolves.toBe(runtime);
    expect(create).toHaveBeenCalledWith({
      authPath: "/agent/auth.json",
      modelsPath: "/agent/models.json",
      allowModelNetwork: true,
      modelRefreshTimeoutMs: 5_000,
    });
  });
});
