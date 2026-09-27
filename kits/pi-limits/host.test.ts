import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, RuntimeExtensionFactory } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { PI_LIMITS_EXTENSION_ID, createPiLimitsHostExtension } from "./host.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

type Handler = (event: { type: string; status: number; headers: Record<string, string> }, ctx: { model?: { provider: string; id: string } }) => void;

async function harness(agentDir = "/nonexistent-agent") {
  const stateDir = await mkdtemp(join(tmpdir(), "tau-pi-limits-"));
  directories.push(stateDir);
  const handlers: Handler[] = [];
  const registry = await activateHostKit(createPiLimitsHostExtension({ now: () => 5_000 }), {
    stateDir,
    agentDir,
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

  it("names each login's account by a hash only: ChatGPT's from Pi's auth.json, Anthropic's from its answers", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "tau-pi-limits-agent-"));
    directories.push(agentDir);
    const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const access = `${part({ alg: "none" })}.${part({ "https://api.openai.com/auth": { chatgpt_account_id: "acct-fixture-1", chatgpt_user_id: "user-fixture-1" } })}.fixture`;
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", access, refresh: "fixture-refresh", expires: 1, accountId: "acct-fixture-1" } }));
    const { respond, read, registry, stateDir } = await harness(agentDir);
    respond("openai-codex", { "x-codex-primary-used-percent": "20" });
    respond("anthropic", { "anthropic-ratelimit-unified-5h-utilization": "0.4", "anthropic-organization-id": "org-fixture-1" });
    respond("anthropic", { "anthropic-ratelimit-unified-7d-utilization": "0.1" });
    const answer = await read() as { accounts: Array<{ id: string; identity?: { provider: string; key: string } }> };
    expect(answer.accounts.map((account) => [account.id, account.identity])).toEqual([
      ["pi:openai-codex", { provider: "openai", key: "6aebdfd5da11cc4ac9092578eb4af5ffb0b9d3a3dee6976ae83ed5354ce94131" }],
      ["pi:anthropic", { provider: "anthropic", key: "afc3cb12c42d1e5bc2bdc82626464d958a551fd461eb8a992861f720f57d0ef5" }],
    ]);
    await registry.deactivate(PI_LIMITS_EXTENSION_ID);
    const saved = await readFile(join(stateDir, PI_LIMITS_EXTENSION_ID, "limits.json"), "utf8");
    expect(saved).not.toMatch(/fixture/u);
    expect(JSON.parse(saved).providers.anthropic.identity.provider).toBe("anthropic");
  });
});
