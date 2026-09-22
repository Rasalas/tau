import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { npmLatestVersion, packageUpdateCommand } from "./cli-versions.js";

function registry(version: string | undefined, ok = true) {
  return vi.fn(async () => ({ ok, json: async () => ({ version }) }) as Response);
}

describe("npmLatestVersion", () => {
  it("asks the registry once a day and answers from the cache in between", async () => {
    const cacheFile = join(await mkdtemp(join(tmpdir(), "tau-npm-")), "versions.json");
    let now = 1_000;
    const fetch = registry("0.155.1");
    expect(await npmLatestVersion("@openai/codex", { cacheFile, fetch, now: () => now })).toBe("0.155.1");
    expect(fetch).toHaveBeenCalledWith("https://registry.npmjs.org/@openai/codex/latest", expect.objectContaining({ headers: { accept: "application/json" } }));
    now += 60_000;
    expect(await npmLatestVersion("@openai/codex", { cacheFile, fetch, now: () => now })).toBe("0.155.1");
    expect(fetch).toHaveBeenCalledTimes(1);
    now += 24 * 60 * 60 * 1000;
    const next = registry("0.156.0");
    expect(await npmLatestVersion("@openai/codex", { cacheFile, fetch: next, now: () => now })).toBe("0.156.0");
    expect(JSON.parse(await readFile(cacheFile, "utf8")).packages["@openai/codex"].version).toBe("0.156.0");
  });

  it("falls back to a stale answer, or none, when the registry fails", async () => {
    const cacheFile = join(await mkdtemp(join(tmpdir(), "tau-npm-")), "versions.json");
    expect(await npmLatestVersion("pkg", { cacheFile, fetch: vi.fn(async () => { throw new Error("offline"); }) })).toBeUndefined();
    await npmLatestVersion("pkg", { cacheFile, fetch: registry("1.0.0"), now: () => 0 });
    expect(await npmLatestVersion("pkg", { cacheFile, fetch: registry(undefined, false), now: () => 10 * 24 * 60 * 60 * 1000 })).toBe("1.0.0");
  });
});

describe("packageUpdateCommand", () => {
  it("names the package manager that owns the resolved executable", () => {
    expect(packageUpdateCommand("/opt/homebrew/Caskroom/codex/0.154.0/bin/codex", "@openai/codex")).toBe("brew upgrade --cask codex");
    expect(packageUpdateCommand("/opt/homebrew/Cellar/codex/0.154.0/bin/codex", "@openai/codex")).toBe("brew upgrade codex");
    expect(packageUpdateCommand("/usr/local/lib/node_modules/@openai/codex/bin/codex.js", "@openai/codex")).toBe("npm install -g @openai/codex@latest");
    expect(packageUpdateCommand("/Users/me/.bun/install/global/node_modules/@openai/codex/bin/codex.js", "@openai/codex")).toBe("bun add -g @openai/codex@latest");
    expect(packageUpdateCommand("/Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js", "@openai/codex")).toBe("pnpm add -g @openai/codex@latest");
    expect(packageUpdateCommand("/Users/me/.local/share/claude/versions/2.1.280", "@anthropic-ai/claude-code")).toBeUndefined();
  });
});
