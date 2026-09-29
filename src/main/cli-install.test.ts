import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cliCommandText, cliMaintenance, detectCliInstall, executableFingerprint, homebrewKeg, npmGlobalPrefix, type CliPackageSpec } from "./cli-install.js";

const CODEX: CliPackageSpec = { npm: "@openai/codex", homebrew: { casks: ["codex"], formulae: ["codex"] } };
const NATIVE: CliPackageSpec = { npm: "@example/agent", homebrew: { casks: ["agent"] }, native: { args: ["update"], paths: ["/.local/share/agent/"] } };

function system(links: Record<string, string>, commands: Record<string, string>) {
  return {
    realpath: async (path: string) => links[path] ?? path,
    findCommand: (name: string) => commands[name],
    platform: "darwin" as const,
    home: "/Users/me",
  };
}

describe("detectCliInstall", () => {
  it("reads a Homebrew cask and upgrades it with the brew of its prefix", async () => {
    const install = await detectCliInstall("/opt/homebrew/bin/codex", CODEX, system(
      { "/opt/homebrew/bin/codex": "/opt/homebrew/Caskroom/codex/0.159.0/codex-aarch64-apple-darwin", "/opt/homebrew/bin/brew": "/opt/homebrew/bin/brew" },
      { brew: "/opt/homebrew/bin/brew" },
    ));
    expect(install).toMatchObject({ method: "homebrew-cask", label: "Homebrew cask codex", name: "codex", update: { executable: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] } });
  });

  it("leaves a keg of an unknown name or another prefix's brew alone", async () => {
    const unknown = await detectCliInstall("/opt/homebrew/bin/codex", CODEX, system({ "/opt/homebrew/bin/codex": "/opt/homebrew/Cellar/evil;rm/1/bin/codex" }, { brew: "/opt/homebrew/bin/brew" }));
    expect(unknown.update).toBeUndefined();
    expect(unknown.note).toContain("does not know");
    const other = await detectCliInstall("/usr/local/bin/codex", CODEX, system(
      { "/usr/local/bin/codex": "/usr/local/Cellar/codex/0.1/bin/codex", "/opt/homebrew/bin/brew": "/opt/homebrew/bin/brew" },
      { brew: "/opt/homebrew/bin/brew" },
    ));
    expect(other.update).toBeUndefined();
  });

  it("finds npm's prefix from the package path and keeps the install there", async () => {
    const install = await detectCliInstall("/Users/me/.local/bin/codex", CODEX, system(
      { "/Users/me/.local/bin/codex": "/Users/me/.local/lib/node_modules/@openai/codex/bin/codex.js" },
      { npm: "/opt/homebrew/bin/npm" },
    ));
    expect(install).toMatchObject({ method: "npm", label: "npm in ~/.local", prefix: "/Users/me/.local", update: { executable: "/opt/homebrew/bin/npm", args: ["install", "-g", "--prefix", "/Users/me/.local", "@openai/codex@latest"] } });
  });

  it("takes a global under a Homebrew Node for npm's, not brew's", async () => {
    const install = await detectCliInstall("/opt/homebrew/bin/codex", CODEX, system(
      { "/opt/homebrew/bin/codex": "/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js" },
      { npm: "/opt/homebrew/bin/npm", brew: "/opt/homebrew/bin/brew" },
    ));
    expect(install.method).toBe("npm");
  });

  it("uses the CLI's own updater under the path the kit names", async () => {
    const install = await detectCliInstall("/Users/me/.local/bin/agent", NATIVE, system({ "/Users/me/.local/bin/agent": "/Users/me/.local/share/agent/versions/2.1.284" }, {}));
    expect(install).toMatchObject({ method: "native", update: { executable: "/Users/me/.local/bin/agent", args: ["update"] } });
  });

  it("knows pnpm and bun globals and nothing else", async () => {
    const pnpm = await detectCliInstall("/Users/me/Library/pnpm/codex", CODEX, system({ "/Users/me/Library/pnpm/codex": "/Users/me/Library/pnpm/global/5/node_modules/@openai/codex/bin/codex.js" }, { pnpm: "/usr/bin/pnpm" }));
    expect(pnpm.update).toEqual({ executable: "/usr/bin/pnpm", args: ["add", "-g", "@openai/codex@latest"] });
    const bun = await detectCliInstall("/Users/me/.bun/bin/codex", CODEX, system({ "/Users/me/.bun/bin/codex": "/Users/me/.bun/install/global/node_modules/@openai/codex/bin/codex.js" }, {}));
    expect(bun).toMatchObject({ method: "bun", note: "bun is not on the PATH." });
    const unknown = await detectCliInstall("/Users/me/bin/codex", CODEX, system({}, { npm: "/usr/bin/npm" }));
    expect(unknown).toMatchObject({ method: "unknown" });
    expect(unknown.update).toBeUndefined();
  });

  it("does not take a project's node_modules for a global install", () => {
    expect(npmGlobalPrefix("/work/app/node_modules/x/lib/node_modules/@openai/codex/bin/codex.js", "@openai/codex", "linux")).toBeUndefined();
    expect(npmGlobalPrefix("C:/Users/me/AppData/Roaming/npm/node_modules/@openai/codex/bin/codex.js", "@openai/codex", "win32")).toBe("C:/Users/me/AppData/Roaming/npm");
    expect(homebrewKeg("/opt/homebrew/Cellar/opencode/1.2.3/bin/opencode")).toEqual({ kind: "formula", name: "opencode", prefix: "/opt/homebrew" });
  });
});

describe("cliMaintenance", () => {
  const cask = system(
    { "/opt/homebrew/bin/codex": "/opt/homebrew/Caskroom/codex/0.159.0/codex", "/opt/homebrew/bin/brew": "/opt/homebrew/bin/brew" },
    { brew: "/opt/homebrew/bin/brew", npm: "/opt/homebrew/bin/npm" },
  );
  const registry = (answers: Record<string, unknown>): typeof fetch => (async (url: string | URL | Request) => {
    const body = answers[String(url)];
    return body ? new Response(JSON.stringify(body)) : new Response("", { status: 404 });
  }) as typeof fetch;
  let dir: string | undefined;
  afterEach(async () => { if (dir) await rm(dir, { recursive: true, force: true }); dir = undefined; });

  it("says Homebrew lags npm and offers the switch, Homebrew out first and back when npm fails", async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-cli-install-"));
    const answer = await cliMaintenance({
      tool: "codex",
      path: "/opt/homebrew/bin/codex",
      installed: "0.159.0",
      spec: CODEX,
      cacheFile: join(dir, "latest.json"),
      env: {},
      fetch: registry({
        "https://registry.npmjs.org/@openai/codex/latest": { version: "0.159.1" },
        "https://formulae.brew.sh/api/cask/codex.json": { version: "0.159.0,abc" },
      }),
      ...cask,
    });
    expect(answer.latest).toBe("0.159.0");
    expect(answer.behind).toEqual({ source: "homebrew", latest: "0.159.0", newer: { source: "npm", latest: "0.159.1" } });
    expect(answer.switch?.steps.map((step) => cliCommandText(step))).toEqual(["brew uninstall --cask codex", "npm install -g @openai/codex@latest"]);
    expect(answer.switch?.restore.map((step) => cliCommandText(step))).toEqual(["brew install --cask codex"]);
  });

  it("offers nothing to switch to while Homebrew is current, and asks nobody with updates off", async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-cli-install-"));
    const fetchers = registry({
      "https://registry.npmjs.org/@openai/codex/latest": { version: "0.159.1" },
      "https://formulae.brew.sh/api/cask/codex.json": { version: "0.159.1" },
    });
    const current = await cliMaintenance({ tool: "codex", path: "/opt/homebrew/bin/codex", spec: CODEX, cacheFile: join(dir, "a.json"), env: {}, fetch: fetchers, ...cask });
    expect(current.behind).toBeUndefined();
    expect(current.switch).toBeUndefined();
    let asked = false;
    const off = await cliMaintenance({ tool: "codex", path: "/opt/homebrew/bin/codex", spec: CODEX, cacheFile: join(dir, "b.json"), env: { TAU_NO_RUNTIME_UPDATES: "1" }, fetch: (async () => { asked = true; return new Response("{}"); }) as typeof fetch, ...cask });
    expect(asked).toBe(false);
    expect(off.latest).toBeUndefined();
  });
});

describe("executableFingerprint", () => {
  it("changes when the file is replaced", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-fingerprint-"));
    try {
      const file = join(dir, "codex");
      await writeFile(file, "one");
      await utimes(file, 1_000, 1_000);
      const before = await executableFingerprint(file);
      await writeFile(file, "two!");
      await utimes(file, 2_000, 2_000);
      expect(await executableFingerprint(file)).not.toBe(before);
      expect(await executableFingerprint(join(dir, "gone"))).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cliCommandText", () => {
  it("names package managers by name and quotes the rest", () => {
    expect(cliCommandText({ executable: "/opt/homebrew/bin/brew", args: ["upgrade", "--cask", "codex"] })).toBe("brew upgrade --cask codex");
    expect(cliCommandText({ executable: "/Users/Jane Doe/.local/bin/agent", args: ["update"] }, "darwin")).toBe("'/Users/Jane Doe/.local/bin/agent' update");
  });
});
