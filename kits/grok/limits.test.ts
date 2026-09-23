import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BILLING_URL, limitWindows, readGrokLimits } from "./limits.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function home(files: Record<string, string> = {}): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-grok-limits-"));
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  for (const [name, text] of Object.entries(files)) await writeFile(join(directory, name), text);
  return directory;
}

const AUTH = JSON.stringify({ "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": { key: "token-1", auth_mode: "oauth" } });
const BILLING = { config: { creditUsagePercent: 37.5, currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-09-28T00:00:00Z" } } };

describe("Grok plan limits", () => {
  it("reads the credit window of the billing answer", () => {
    expect(limitWindows(BILLING)).toEqual([{ id: "subscription", kind: "weekly", label: "Weekly", usedPercent: 37.5, resetsAt: Date.parse("2026-09-28T00:00:00Z") }]);
    expect(limitWindows({ config: { creditUsagePercent: 140 } })).toEqual([{ id: "subscription", kind: "other", label: "Subscription", usedPercent: 100 }]);
    expect(limitWindows({})).toEqual([]);
  });

  it("asks xAI with the login's token, and only for the default login", async () => {
    const fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => BILLING }) as unknown as Response);
    const grokHome = await home({ "auth.json": AUTH });
    await expect(readGrokLimits({ env: { GROK_HOME: grokHome }, fetch })).resolves.toEqual({ windows: limitWindows(BILLING) });
    expect(fetch).toHaveBeenCalledWith(BILLING_URL, expect.objectContaining({ headers: { Authorization: "Bearer token-1" } }));

    fetch.mockClear();
    await expect(readGrokLimits({ env: { GROK_HOME: grokHome, XAI_API_KEY: "k" }, fetch })).resolves.toMatchObject({ unavailable: { reason: "unsupported" } });
    await expect(readGrokLimits({ env: { GROK_HOME: grokHome, GROK_CLI_CHAT_PROXY_BASE_URL: "https://proxy" }, fetch })).resolves.toMatchObject({ unavailable: { reason: "unsupported" } });
    const custom = await home({ "auth.json": AUTH, "config.toml": "[endpoints]\nchat = \"x\"\n" });
    await expect(readGrokLimits({ env: { GROK_HOME: custom }, fetch })).resolves.toMatchObject({ unavailable: { reason: "unsupported" } });
    await expect(readGrokLimits({ env: { GROK_HOME: await home() }, fetch })).resolves.toMatchObject({ unavailable: { reason: "signed-out" } });
    const keyed = await home({ "auth.json": JSON.stringify({ "https://accounts.x.ai/sign-in": { key: "k", auth_mode: "api_key" } }) });
    await expect(readGrokLimits({ env: { GROK_HOME: keyed }, fetch })).resolves.toMatchObject({ unavailable: { reason: "signed-out" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("says the read failed when xAI refuses or answers nonsense", async () => {
    const grokHome = await home({ "auth.json": AUTH });
    const refused = vi.fn(async () => ({ ok: false, status: 401 }) as unknown as Response);
    await expect(readGrokLimits({ env: { GROK_HOME: grokHome }, fetch: refused })).resolves.toMatchObject({ unavailable: { reason: "failed", message: "xAI answered 401." } });
    const broken = vi.fn(async () => ({ ok: true, status: 200, json: async () => { throw new Error("bad json"); } }) as unknown as Response);
    await expect(readGrokLimits({ env: { GROK_HOME: grokHome }, fetch: broken })).resolves.toMatchObject({ unavailable: { reason: "failed" } });
  });
});
