import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { derivePort, findFreePort, parseArgs, seedConfigFile } from "./dev-instance.mjs";

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
      port: undefined,
      workspace: undefined,
      agentDir: undefined,
    });
  });

  it("reads boolean flags", () => {
    expect(parseArgs(["--build", "--safe", "--fresh", "--shared-sessions"])).toEqual({
      build: true,
      safe: true,
      fresh: true,
      sharedSessions: true,
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
