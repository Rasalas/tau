import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { claudeResetCredits, consumeClaudeResetCredit, readClaudeResetCredits, type ResetAccess } from "./reset-credits.js";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function access(): Promise<ResetAccess> {
  const configDir = await mkdtemp(join(tmpdir(), "tau-reset-test-")); dirs.push(configDir);
  await writeFile(join(configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "test-token" } }));
  const accountFile = join(configDir, ".claude.json");
  await writeFile(accountFile, JSON.stringify({ oauthAccount: { organizationUuid: "test/org" } }));
  return { configDir, accountFile, version: "2.1.1", platform: "linux" };
}
it("counts only eligible unpaused unexpired grants selected by the provider", () => {
  const now = Date.parse("2026-02-01T00:00:00Z");
  const grant = { id: "grant_1", resets_left: 2, usable_now: true, ends_at: "2026-03-01T00:00:00Z" };
  expect(claudeResetCredits({ eligible: true, next_grant_id: "grant_1", grants: [grant, { ...grant, id: "expired", ends_at: "2025-01-01T00:00:00Z" }, { ...grant, id: "paused", paused: true }, { ...grant, id: "invalid", ends_at: "2026-02-30T00:00:00Z" }] }, now)).toEqual({ availableCount: 2, nextCreditId: "grant_1", nextExpiresAt: Date.parse(grant.ends_at) });
  expect(claudeResetCredits({ eligible: true, next_grant_id: "gone", grants: [grant] }, now)?.availableCount).toBe(0);
});
it("never reads Keychain or contacts Claude on macOS", async () => {
  const fetcher = vi.fn();
  const input = { configDir: "/nonexistent-test", accountFile: "/nonexistent-test", version: "2.1.1", platform: "darwin", fetch: fetcher };
  expect((await readClaudeResetCredits(input))?.unavailable).toContain("Keychain");
  await expect(consumeClaudeResetCredit(input, "grant_1", "request_1")).rejects.toMatchObject({ settled: true });
  expect(fetcher).not.toHaveBeenCalled();
});
it("uses the exact OAuth usage and claim operations with a stable request id", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ cedar_ember: { eligible: true, next_grant_id: "grant_1", grants: [{ id: "grant_1", resets_left: 1, usable_now: true }] } }))).mockResolvedValueOnce(new Response(JSON.stringify({ result: "reset" })));
  const input = { ...await access(), fetch: fetcher };
  expect((await readClaudeResetCredits(input))?.availableCount).toBe(1);
  expect(fetcher.mock.calls[0]?.[0]).toBe("https://api.anthropic.com/api/oauth/usage?cedar_ember=1&skip_spend=1");
  expect(await consumeClaudeResetCredit(input, "grant_1", "request_1")).toBe("reset");
  expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.anthropic.com/api/organizations/test%2Forg/reset_rate_limits");
  expect(JSON.parse(fetcher.mock.calls[1]?.[1].body)).toEqual({ program: "cedar_ember", grant_id: "grant_1", request_id: "request_1" });
  expect(fetcher.mock.calls[1]?.[1].headers).toMatchObject({ authorization: "Bearer test-token", "anthropic-beta": "oauth-2025-04-20" });
});
it.each([[429, true], [401, true], [503, false]])("categorizes HTTP %s without leaking credentials", async (status, settled) => {
  const input = { ...await access(), fetch: vi.fn().mockResolvedValue(new Response("test-token", { status })) };
  await expect(consumeClaudeResetCredit(input, "grant_1", "request_1")).rejects.toMatchObject({ settled });
});
it.each([["cooldown", true], ["unavailable", false], ["unknown_result", false]])("preserves uncertain result %s", async (result, settled) => {
  const input = { ...await access(), fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ result }))) };
  await expect(consumeClaudeResetCredit(input, "grant_1", "request_1")).rejects.toMatchObject({ settled });
});
