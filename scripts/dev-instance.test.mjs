import { describe, expect, it } from "vitest";
import { lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePort, findFreePort, freshPaths, hasSavedProject, parseArgs, prepareCodexHome, preparePiAgentDir, seedConfigFile, seedOnboarding } from "./dev-instance.mjs";

describe("derivePort", () => {
  it("is deterministic for the same seed", () => {
    expect(derivePort("/a/worktree/path")).toBe(derivePort("/a/worktree/path"));
  });

  it("stays inside the requested range", () => {
    for (const seed of ["/a", "/b/worktree", "/very/long/nested/path/to/a/tau-worktree"]) {
      const port = derivePort(seed);
      expect(port).toBeGreaterThanOrEqual(9300);
      expect(port).toBeLessThan(9400);
    }
  });

  it("differs for different seeds (not a constant)", () => {
    const ports = new Set(["/one", "/two", "/three", "/four", "/five"].map((seed) => derivePort(seed)));
    expect(ports.size).toBeGreaterThan(1);
  });

  it("honors a custom base and range", () => {
    const port = derivePort("/seed", { base: 10_000, range: 10 });
    expect(port).toBeGreaterThanOrEqual(10_000);
    expect(port).toBeLessThan(10_010);
  });
});

describe("findFreePort", () => {
  it("returns the derived port when it is free", async () => {
    const seed = "/free/seed";
    const port = await findFreePort(seed, { isFree: async () => true });
    expect(port).toBe(derivePort(seed));
  });

  it("scans forward, wrapping within the range, past occupied ports", async () => {
    const base = 9300;
    const range = 5;
    const seed = "/wraps";
    const start = derivePort(seed, { base, range });
    const occupied = new Set([start, base + ((start - base + 1) % range)]);
    const port = await findFreePort(seed, { base, range, isFree: async (candidate) => !occupied.has(candidate) });
    expect(occupied.has(port)).toBe(false);
    expect(port).toBeGreaterThanOrEqual(base);
    expect(port).toBeLessThan(base + range);
  });

  it("throws when every port in the range is occupied", async () => {
    await expect(findFreePort("/full", { range: 3, isFree: async () => false })).rejects.toThrow(/no free port/);
  });
});

describe("parseArgs", () => {
  it("defaults every flag to off", () => {
    expect(parseArgs([])).toEqual({
      build: false,
      safe: false,
      fresh: false,
      sharedSessions: false,
      realAgentDir: false,
      asInstalled: false,
      onboarding: false,
      port: undefined,
      workspace: undefined,
      agentDir: undefined,
    });
  });

  it("reads boolean flags", () => {
    expect(parseArgs(["--build", "--safe", "--fresh", "--shared-sessions", "--real-agent-dir"])).toEqual({
      build: true,
      safe: true,
      fresh: true,
      sharedSessions: true,
      realAgentDir: true,
      asInstalled: false,
      onboarding: false,
      port: undefined,
      workspace: undefined,
      agentDir: undefined,
    });
  });

  it("reads --port as a number", () => {
    expect(parseArgs(["--port", "9345"]).port).toBe(9345);
  });

  it("reads --workspace as a path", () => {
    expect(parseArgs(["--workspace", "/tmp/some-repo"]).workspace).toBe("/tmp/some-repo");
  });

  it("reads --as-installed, but not with a --workspace or --fresh", () => {
    expect(parseArgs(["--as-installed"]).asInstalled).toBe(true);
    expect(() => parseArgs(["--as-installed", "--workspace", "/tmp/some-repo"])).toThrow(/--as-installed names no workspace/);
    expect(() => parseArgs(["--as-installed", "--fresh"])).toThrow(/--fresh start wipes/);
  });

  it("reads --agent-dir as a path", () => {
    expect(parseArgs(["--agent-dir", "/tmp/shadow-agent"]).agentDir).toBe("/tmp/shadow-agent");
  });

  it("rejects a --agent-dir with no value", () => {
    expect(() => parseArgs(["--agent-dir"])).toThrow(/--agent-dir needs a path/);
  });

  it("rejects a non-numeric --port", () => {
    expect(() => parseArgs(["--port", "nope"])).toThrow(/--port needs a number/);
  });

  it("rejects a --port with no value", () => {
    expect(() => parseArgs(["--port"])).toThrow(/--port needs a number/);
  });

  it("rejects a --workspace with no value", () => {
    expect(() => parseArgs(["--workspace"])).toThrow(/--workspace needs a path/);
  });

  it("rejects an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown flag "--bogus"/);
  });
});

describe("seedOnboarding", () => {
  const welcome = (userData) => join(userData, "kit-state", "tau.onboarding", "welcome.json");

  it("marks the wizard done unless --onboarding asks for it", () => {
    const userData = mkdtempSync(join(tmpdir(), "tau-dev-onboarding-"));
    seedOnboarding(userData, false);
    expect(JSON.parse(readFileSync(welcome(userData), "utf8")).completedAt).toEqual(expect.any(String));
    seedOnboarding(userData, true);
    expect(() => readFileSync(welcome(userData))).toThrow();
    expect(parseArgs(["--onboarding"]).onboarding).toBe(true);
    expect(parseArgs([]).onboarding).toBe(false);
  });
});

describe("seedConfigFile", () => {
  it("copies the user's config once and never writes it back", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-dev-config-"));
    const real = join(dir, "real.json");
    const own = join(dir, "dev", "tau-config.json");
    writeFileSync(real, '{"favouriteModels":["a/b"]}');
    seedConfigFile(own, real);
    expect(readFileSync(own, "utf8")).toBe('{"favouriteModels":["a/b"]}');
    writeFileSync(own, '{"hostBackground":true}');
    seedConfigFile(own, real);
    expect(readFileSync(own, "utf8")).toBe('{"hostBackground":true}');
    expect(readFileSync(real, "utf8")).toBe('{"favouriteModels":["a/b"]}');
  });

  it("starts empty when the user has no config", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-dev-config-"));
    const own = join(dir, "tau-config.json");
    seedConfigFile(own, join(dir, "missing.json"));
    expect(JSON.parse(readFileSync(own, "utf8"))).toEqual({});
  });
});

describe("prepareCodexHome", () => {
  it("links only the user's login into the instance's Codex home, once", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-dev-codex-"));
    const real = join(dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "auth.json"), "{}");
    writeFileSync(join(real, "config.toml"), "model = 'x'");
    const own = join(dir, "dev", "codex-home");
    prepareCodexHome(own, real);
    prepareCodexHome(own, real);
    expect(readdirSync(own)).toEqual(["auth.json"]);
    expect(readlinkSync(join(own, "auth.json"))).toBe(join(real, "auth.json"));
  });

  it("creates an empty home when the user never signed in", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-dev-codex-"));
    prepareCodexHome(join(dir, "home"), join(dir, "missing"));
    expect(readdirSync(join(dir, "home"))).toEqual([]);
  });
});

describe("preparePiAgentDir", () => {
  it("links the login and packages, copies settings once, and never writes the real directory", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-dev-pi-agent-"));
    const real = join(root, "real");
    mkdirSync(join(real, "npm"), { recursive: true });
    writeFileSync(join(real, "auth.json"), "{}");
    writeFileSync(join(real, "settings.json"), '{"lastChangelogVersion":"0.84.4"}');
    const own = join(root, "own");
    preparePiAgentDir(own, real);
    expect(readlinkSync(join(own, "auth.json"))).toBe(join(real, "auth.json"));
    expect(readlinkSync(join(own, "npm"))).toBe(join(real, "npm"));
    writeFileSync(join(own, "settings.json"), '{"lastChangelogVersion":"0.85.1"}');
    preparePiAgentDir(own, real);
    expect(readFileSync(join(own, "settings.json"), "utf8")).toContain("0.85.1");
    expect(readFileSync(join(real, "settings.json"), "utf8")).toContain("0.84.4");
    expect(readdirSync(own).sort()).toEqual(["auth.json", "npm", "settings.json"]);
  });

  it("points the copied settings at the test model, whatever the real default is", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-dev-pi-agent-"));
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "settings.json"), '{"defaultProvider":"openai-codex","defaultModel":"gpt-5.6-sol","theme":"dark"}');
    const own = join(root, "own");
    preparePiAgentDir(own, real);
    expect(JSON.parse(readFileSync(join(own, "settings.json"), "utf8"))).toEqual({ defaultProvider: "openai-codex", defaultModel: "gpt-5.6-luna", theme: "dark" });
    expect(readFileSync(join(real, "settings.json"), "utf8")).toContain("gpt-5.6-sol");
  });

  it("copies keybindings.json, and turns a link an older instance made into a copy", () => {
    const root = mkdtempSync(join(tmpdir(), "tau-dev-pi-agent-"));
    const real = join(root, "real");
    mkdirSync(real, { recursive: true });
    writeFileSync(join(real, "keybindings.json"), '{"app.exit":"ctrl+d"}');
    const own = join(root, "own");
    preparePiAgentDir(own, real);
    expect(lstatSync(join(own, "keybindings.json")).isSymbolicLink()).toBe(false);

    const older = join(root, "older");
    mkdirSync(older);
    symlinkSync(join(real, "keybindings.json"), join(older, "keybindings.json"));
    preparePiAgentDir(older, real);
    expect(lstatSync(join(older, "keybindings.json")).isSymbolicLink()).toBe(false);
    writeFileSync(join(older, "keybindings.json"), "{}");
    expect(readFileSync(join(real, "keybindings.json"), "utf8")).toBe('{"app.exit":"ctrl+d"}');
  });
});

describe("freshPaths", () => {
  it("wipes the runtime kits' thread stores beside the session store, so imported conversations go too", () => {
    expect(freshPaths({ userData: "/w/.tau-dev/userdata", sessionsDir: "/w/.tau-dev/pi-sessions" }))
      .toEqual(["/w/.tau-dev/userdata", "/w/.tau-dev/pi-sessions", "/w/.tau-dev/tau"]);
  });

  it("leaves a shared session store and its neighbours alone", () => {
    expect(freshPaths({ userData: "/w/.tau-dev/userdata", sessionsDir: undefined })).toEqual(["/w/.tau-dev/userdata"]);
  });
});

describe("hasSavedProject", () => {
  it("counts a project on disk, never / and never a missing folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "tau-dev-projects-"));
    expect(hasSavedProject(dir)).toBe(false);
    const write = (paths) => writeFileSync(join(dir, "projects.json"), JSON.stringify({ version: 2, projects: paths.map((path) => ({ path, name: path, lastOpenedAt: 1 })) }));
    write(["/", join(dir, "gone")]);
    expect(hasSavedProject(dir)).toBe(false);
    write(["/", dir]);
    expect(hasSavedProject(dir)).toBe(true);
  });
});
