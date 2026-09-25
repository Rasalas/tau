import { mkdtemp, readFile, realpath, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanTree } from "./secrets-scan.js";
import { ServersStore } from "./store.js";
import { TRUST_FILE, blockUpload, readTrust, recordLiveConfigs, unblockUpload, updateTrust } from "./trust.js";

const PROJECTS = join(import.meta.dirname, "fixtures", "projects");
const KEY = { workspaceId: "ws1_trust", targetId: "live" };
const quiet = { warn: () => undefined };

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map((cleanup) => cleanup())); });

async function store(): Promise<ServersStore> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-servers-trust-")));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return new ServersStore(dir, quiet);
}

describe("TRUST_FILE", () => {
  it("cleans what it owns and keeps fields other tickets add", () => {
    expect(TRUST_FILE.decode({
      version: 1,
      uploadBlocklist: ["./b.php", "a.php", "../x", 3, "a.php"],
      liveConfigs: [{ path: ".env", kind: "dotenv", line: 4 }, { path: "x", kind: "unknown" }, { path: "wp-config.php", kind: "wordpress-config", framework: "wordpress" }],
      networkAllow: ["registry.npmjs.org"],
    }, 1)).toEqual({
      uploadBlocklist: ["a.php", "b.php"],
      liveConfigs: [{ path: ".env", kind: "dotenv" }, { path: "wp-config.php", kind: "wordpress-config", framework: "wordpress" }],
      networkAllow: ["registry.npmjs.org"],
    });
    expect(TRUST_FILE.decode([], 1)).toBeUndefined();
    expect(TRUST_FILE.decode({}, undefined)).toEqual({ uploadBlocklist: [], liveConfigs: [] });
  });
});

describe("the upload block list", () => {
  it("adds and removes project paths, and both of two quick changes land", async () => {
    const servers = await store();
    await Promise.all([blockUpload(servers, KEY, "wp-config-local.php"), blockUpload(servers, KEY, "./.env.local")]);
    expect((await readTrust(servers, KEY)).uploadBlocklist).toEqual([".env.local", "wp-config-local.php"]);
    await unblockUpload(servers, KEY, ".env.local");
    expect((await readTrust(servers, KEY)).uploadBlocklist).toEqual(["wp-config-local.php"]);
  });

  it("refuses a path outside the project", async () => {
    const servers = await store();
    await expect(blockUpload(servers, KEY, "../../etc/passwd")).rejects.toThrow("inside the project");
    await expect(blockUpload(servers, KEY, "/etc/passwd")).rejects.toThrow("inside the project");
  });

  it("keeps a failed change from blocking the next one", async () => {
    const servers = await store();
    await expect(updateTrust(servers, KEY, () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await blockUpload(servers, KEY, "a.php");
    expect((await readTrust(servers, KEY)).uploadBlocklist).toEqual(["a.php"]);
  });

  it("keeps another ticket's fields on rewrite", async () => {
    const servers = await store();
    const dir = servers.targetDir(KEY);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "trust.json"), JSON.stringify({ version: 1, uploadBlocklist: [], liveConfigs: [], commandApprovals: ["ls"] }));
    await blockUpload(servers, KEY, "a.php");
    expect(JSON.parse(await readFile(join(dir, "trust.json"), "utf8"))).toEqual({ version: 1, uploadBlocklist: ["a.php"], liveConfigs: [], commandApprovals: ["ls"] });
  });
});

describe("recordLiveConfigs", () => {
  it("stores path and kind of a full scan, never a value", async () => {
    const servers = await store();
    await recordLiveConfigs(servers, KEY, await scanTree(join(PROJECTS, "laravel")));
    expect((await readTrust(servers, KEY)).liveConfigs).toEqual([
      { path: ".env", kind: "dotenv" },
      { path: ".env", kind: "redis-dsn" },
      { path: ".env", kind: "smtp-dsn" },
      { path: ".env", kind: "stripe-live-key" },
    ]);
    const text = await readFile(join(servers.targetDir(KEY), "trust.json"), "utf8");
    for (const value of ["fake-password-not-real", "example.invalid", "TESTONLY", "VEVTVE9OTFk"]) expect(text).not.toContain(value);
  });

  it("replaces only the scanned paths after a partial scan", async () => {
    const servers = await store();
    await recordLiveConfigs(servers, KEY, [{ path: ".env", kind: "dotenv", line: 1 }, { path: "wp-config.php", kind: "wordpress-config", line: 2, framework: "wordpress" }]);
    await recordLiveConfigs(servers, KEY, [], [".env"]);
    expect((await readTrust(servers, KEY)).liveConfigs).toEqual([{ path: "wp-config.php", kind: "wordpress-config", framework: "wordpress" }]);
  });
});
