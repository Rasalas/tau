import { expect, it, vi } from "vitest";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createEnvironmentsHostExtension } from "./host.js";
import { ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE_SELECTED } from "./protocol.js";

it("updates only the programs approved in the reviewed plan", async () => {
  const runtimeTools = vi.fn(async () => ({ tools: ["pi", "other"].map((kind) => ({
    kinds: [kind], label: kind, tool: kind, installed: "1.0.0", latest: "2.0.0", source: "npm", update: "update",
  })), log: [] }));
  const registry = await activateHostKit(createEnvironmentsHostExtension(), { runtimeTools });
  await registry.invoke(ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE_SELECTED, { kinds: ["pi"] });
  expect(runtimeTools.mock.calls).toEqual([["state"], ["update", { kind: "pi" }]]);
});

it("rejects an absent or invalid selection and read-only callers before updating", async () => {
  const runtimeTools = vi.fn();
  const registry = await activateHostKit(createEnvironmentsHostExtension(), { runtimeTools });
  for (const input of [undefined, { kinds: "pi" }, { kinds: [1] }]) {
    await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE_SELECTED, input)).rejects.toThrow();
  }
  await expect(registry.invoke(ENVIRONMENTS_EXTENSION_ID, LOCAL_UPDATE_SELECTED, { kinds: ["pi"] }, {
    kind: "workbench-client", connection: "c", pairedClient: "d", readOnly: true,
  })).rejects.toThrow(/Read.only/u);
  expect(runtimeTools).not.toHaveBeenCalled();
});
