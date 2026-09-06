import { describe, expect, it, vi } from "vitest";
import type { RuntimeExtensionContribution, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createComputerUseHostExtension, settingsIncludeComputerUse } from "./host.js";
import { COMPUTER_USE_PACKAGE, COMPUTER_USE_RUNTIME_EXTENSION } from "./protocol.js";

const piExtension = (() => undefined) as unknown as RuntimeExtensionFactory;

async function activate() {
  const contributions: RuntimeExtensionContribution[] = [];
  const loadRuntimeExtension = vi.fn(async () => piExtension);
  await activateHostKit(createComputerUseHostExtension(), {
    loadRuntimeExtension,
    registerRuntimeExtension: (name, factory, options) => {
      contributions.push({ name, factory, ...options });
      return () => undefined;
    },
  });
  return { contributions, loadRuntimeExtension };
}

describe("Computer Use host extension", () => {
  it("registers the Pi extension the host loaded from Tau's own dependencies", async () => {
    const { contributions, loadRuntimeExtension } = await activate();

    expect(loadRuntimeExtension).toHaveBeenCalledWith(COMPUTER_USE_PACKAGE);
    expect(contributions.map((entry) => entry.name)).toEqual([COMPUTER_USE_RUNTIME_EXTENSION]);
    expect(contributions[0]?.factory).toBe(piExtension);
  });

  it("stands down when the user already configured the Pi package", async () => {
    const { contributions } = await activate();
    const { enabledFor } = contributions[0]!;

    expect(enabledFor?.({ global: {}, project: {} })).toBe(true);
    expect(enabledFor?.({ global: { packages: [`npm:${COMPUTER_USE_PACKAGE}`] }, project: {} })).toBe(false);
    expect(enabledFor?.({ global: {}, project: { packages: [{ source: `npm:${COMPUTER_USE_PACKAGE}@1.0.0` }] } })).toBe(false);
  });

  it("recognizes string and object package declarations and ignores unrelated ones", () => {
    expect(settingsIncludeComputerUse({ packages: [`npm:${COMPUTER_USE_PACKAGE}`] })).toBe(true);
    expect(settingsIncludeComputerUse({ packages: [{ source: `npm:${COMPUTER_USE_PACKAGE}@0.1.12`, autoload: true }] })).toBe(true);
    expect(settingsIncludeComputerUse({ packages: ["npm:pi-subagents"] })).toBe(false);
    expect(settingsIncludeComputerUse({})).toBe(false);
  });
});
