import { expect, it, vi } from "vitest";

const { enableCompileCache } = vi.hoisted(() => ({ enableCompileCache: vi.fn(() => ({ status: 3 })) }));
vi.mock("node:module", () => ({ enableCompileCache }));

it("requests the compile cache and accepts a disabled cache", async () => {
  await import("./compile-cache.js");
  expect(enableCompileCache).toHaveBeenCalledOnce();
});
