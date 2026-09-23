import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { PI_LIMITS_EXTENSION_ID, createPiLimitsHostExtension } from "./host.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

type Handler = (event: { type: string; status: number; headers: Record<string, string> }, ctx: { model?: { provider: string; id: string } }) => void;

async function harness() {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-pi-limits-"));
  directories.push(stateDir);
  const handlers: Handler[] = [];
  const registry = await activateHostKit(createPiLimitsHostExtension({ now: () => 5_000 }), {
    stateDir,
    registerRuntimeExtension: (_name: string, factory: RuntimeExtensionFactory) => {
      factory({ on: (_event: string, handler: Handler) => { handlers.push(handler); } } as never, { sessionId: "s", cwd: "/repo" });
      return () => undefined;
    },
  });
  let read: (() => Promise<unknown>) | undefined;
  const usageKit: HostExtension = { id: "tau.usage", name: "Usage", activate(activation) { read = () => activation.invokeHostExtension(PI_LIMITS_EXTENSION_ID, "usage-limits"); } };
  await registry.activate(usageKit);
  const respond = (provider: string, headers: Record<string, string>) => { for (const handler of handlers) handler({ type: "after_provider_response", status: 200, headers }, { model: { provider, id: "m" } }); };
  return { registry, respond, read: () => read!(), stateDir };
}

describe("Pi Limits host extension", () => {
  it("keeps what each provider's responses say about its windows, and hands them to the Usage kit", async () => {
    const { respond, read, registry, stateDir } = await harness();
    respond("openai-codex", { "x-codex-primary-used-percent": "20", "x-codex-primary-window-minutes": "300" });
    respond("openai-codex", { "x-codex-secondary-used-percent": "5", "x-codex-secondary-window-minutes": "10080" });
    respond("openrouter", { "x-ratelimit-remaining-requests": "10" });
    await expect(read()).resolves.toEqual({
      accounts: [{
        id: "pi:openai-codex", runtime: "pi", label: "Pi · openai-codex", checkedAt: 5_000,
        windows: [expect.objectContaining({ id: "primary", usedPercent: 20 }), expect.objectContaining({ id: "secondary", usedPercent: 5 })],
      }],
    });
    await registry.deactivate(PI_LIMITS_EXTENSION_ID);
    expect(JSON.parse(await readFile(join(stateDir, PI_LIMITS_EXTENSION_ID, "limits.json"), "utf8")).providers["openai-codex"].windows).toHaveLength(2);
  });
});
