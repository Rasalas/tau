import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostUpdateStatus } from "../shared/host-updates.js";
import { NO_JOB_CONTEXT } from "./host-jobs.js";
import { HostUpdater, createUpdateMethods, localWindowUpdatePort, type HostUpdaterOptions, type WindowUpdatePort } from "./host-updater.js";
import type { StagedUpdate, UpdateInstaller } from "./update-installers.js";

const FEED = { owner: "Rasalas", repo: "tau" };
const LOCAL = "http://127.0.0.1:1/feed/";

/** A release feed in memory: `latest-linux.yml` and the files it lists, served by a fake fetch. */
function fakeFeed(version: string, options: { corrupt?: boolean; sign?: (text: string) => string } = {}) {
  const deb = Buffer.from(`tau ${version} package`);
  const name = `Tau_${version}_amd64.deb`;
  const sha512 = createHash("sha512").update(deb).digest("base64");
  const text = [
    `version: ${version}`,
    "files:",
    `  - url: Tau-${version}.AppImage`,
    `    sha512: ${sha512}`,
    `    size: ${deb.length}`,
    `  - url: ${name}`,
    `    sha512: ${sha512}`,
    `    size: ${deb.length}`,
    `path: Tau-${version}.AppImage`,
    `releaseDate: '2026-09-29T10:00:00.000Z'`,
    "",
  ].join("\n");
  const served = new Map<string, () => Response>([
    [`${LOCAL}latest-linux.yml`, () => new Response(text)],
    [`${LOCAL}${name}`, () => new Response(options.corrupt ? Buffer.from("something else entirely") : deb)],
  ]);
  if (options.sign) served.set(`${LOCAL}latest-linux.yml.sig`, () => new Response(options.sign!(text)));
  const requests: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    requests.push(url);
    const answer = served.get(url);
    return answer ? answer() : new Response("not found", { status: 404 });
  });
  return { fetch, requests, name, sha512 };
}

function fakeInstaller(overrides: Partial<UpdateInstaller> = {}) {
  const installed: StagedUpdate[] = [];
  const installer: UpdateInstaller = {
    method: "deb",
    blocked: async () => undefined,
    install: async (update) => { installed.push(update); return "restart"; },
    ...overrides,
  };
  return { installer, installed };
}

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "tau-host-updater-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const log = { info: () => undefined, warn: () => undefined, error: () => undefined };

function updater(options: Partial<HostUpdaterOptions> & Pick<HostUpdaterOptions, "fetch">) {
  const published: HostUpdateStatus[] = [];
  const restart = vi.fn();
  let clock = 1_000_000;
  const instance = new HostUpdater({
    version: "0.7.6",
    arch: "x64",
    platform: "linux",
    feed: FEED,
    feedOverride: LOCAL,
    releaseKeys: [],
    dir,
    channel: async () => undefined,
    publish: (status) => published.push(status),
    log,
    restart,
    now: () => clock,
    quietMs: 60_000,
    ...options,
  });
  return { instance, published, restart, advance: (ms: number) => { clock += ms; } };
}

describe("HostUpdater", () => {
  it("finds a newer release, downloads and verifies it, and installs it once the machine was quiet", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const { instance, restart, published, advance } = updater({ fetch: feed.fetch, installer });
    advance(120_000);
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let status: HostUpdateStatus;
    try {
      status = await instance.check();
      // The answer goes out first; the host leaves a moment later.
      expect(restart).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
    } finally {
      vi.useRealTimers();
    }
    expect(status.phase).toBe("installed");
    expect(status.latest).toBe("0.7.14");
    expect(installed).toEqual([expect.objectContaining({ version: "0.7.14", channel: "stable", sha512: feed.sha512 })]);
    expect(restart).toHaveBeenCalledOnce();
    expect(published.map((entry) => entry.phase)).toEqual(expect.arrayContaining(["checking", "available", "downloading", "ready", "installing", "installed"]));
    // The installed download is not kept.
    expect(readdirSync(dir)).toEqual([]);
  });

  it("waits out the quiet period after a turn before an automatic install", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const { instance } = updater({ fetch: feed.fetch, installer });
    vi.useFakeTimers();
    try {
      expect((await instance.check()).phase).toBe("ready");
      expect(installed).toHaveLength(0);
    } finally {
      instance.dispose();
      vi.useRealTimers();
    }
  });

  it("never installs while a turn runs: Update now waits and installs when the turn ends", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const { instance } = updater({ fetch: feed.fetch, installer });
    instance.observe({ type: "agent-status", sessionId: "a", running: true });
    const waiting = await instance.install();
    expect(waiting.phase).toBe("waiting");
    expect(waiting.runningTurns).toBe(1);
    expect(installed).toHaveLength(0);
    instance.observe({ type: "agent-status", sessionId: "a", running: false });
    await vi.waitFor(() => expect(installed).toHaveLength(1));
    expect(instance.status().phase).toBe("installed");
  });

  it("refuses a download whose checksum does not match, and installs nothing", async () => {
    const feed = fakeFeed("0.7.14", { corrupt: true });
    const { installer, installed } = fakeInstaller();
    const { instance } = updater({ fetch: feed.fetch, installer });
    const status = await instance.install();
    expect(status.phase).toBe("failed");
    expect(status.reason).toMatch(/checksum/u);
    expect(installed).toHaveLength(0);
    expect(existsSync(join(dir, feed.name))).toBe(false);
  });

  it("stays put on the version the feed names, and never goes back to an older one", async () => {
    for (const latest of ["0.7.6", "0.7.5"]) {
      const feed = fakeFeed(latest);
      const { installer, installed } = fakeInstaller();
      const { instance } = updater({ fetch: feed.fetch, installer });
      expect((await instance.install()).phase).toBe("current");
      expect(installed).toHaveLength(0);
    }
  });

  it("with automatic updates off, only reports what is available", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const { instance } = updater({ fetch: feed.fetch, installer });
    instance.updateSettings({ automatic: false });
    const status = await instance.check();
    expect(status).toMatchObject({ phase: "available", latest: "0.7.14", automatic: false });
    expect(feed.requests.some((url) => url.endsWith(".deb"))).toBe(false);
    expect(installed).toHaveLength(0);
    // The setting outlives the process.
    expect(updater({ fetch: feed.fetch, installer }).instance.status().automatic).toBe(false);
  });

  it("requires the release key's signature once the build carries a key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const other = generateKeyPairSync("ed25519").privateKey;
    const cases = [
      { sign: undefined, phase: "failed" },
      { sign: (text: string) => sign(null, Buffer.from(text), other).toString("base64"), phase: "failed" },
      { sign: (text: string) => sign(null, Buffer.from(text), privateKey).toString("base64"), phase: "installed" },
    ] as const;
    for (const entry of cases) {
      const feed = fakeFeed("0.7.14", entry.sign ? { sign: entry.sign } : {});
      const { installer } = fakeInstaller();
      const { instance } = updater({ fetch: feed.fetch, installer, releaseKeys: [raw] });
      expect((await instance.install()).phase).toBe(entry.phase);
    }
  });

  it("reads nightly from the moving tag and stable from the latest release", async () => {
    const requests: string[] = [];
    const fetch = vi.fn(async (url: string) => { requests.push(url); return new Response("", { status: 404 }); });
    const { installer } = fakeInstaller();
    const stable = updater({ fetch, installer, feedOverride: undefined });
    await stable.instance.check();
    const nightly = updater({ fetch, installer, feedOverride: undefined, channel: async () => "nightly" });
    await nightly.instance.check();
    expect(requests).toEqual([
      "https://github.com/Rasalas/tau/releases/latest/download/latest-linux.yml",
      "https://github.com/Rasalas/tau/releases/download/nightly/latest-linux.yml",
    ]);
    expect(nightly.instance.status()).toMatchObject({ channel: "nightly", phase: "failed" });
  });

  it("passes Update now to a Tau window on the machine, and never installs through it on its own", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const window: WindowUpdatePort = {
      attached: () => true,
      state: vi.fn(async () => ({ installs: true })),
      install: vi.fn(async () => ({ started: true })),
    };
    const { instance } = updater({ fetch: feed.fetch, installer, window });
    expect(await instance.check()).toMatchObject({ phase: "available", installer: "window" });
    expect(window.install).not.toHaveBeenCalled();
    expect(feed.requests.some((url) => url.endsWith(".deb"))).toBe(false);
    expect((await instance.install()).phase).toBe("installing");
    expect(window.install).toHaveBeenCalledOnce();
    expect(installed).toHaveLength(0);
  });

  it("installs itself when the window on the machine cannot (an invisible display's)", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const window: WindowUpdatePort = { attached: () => true, state: async () => ({ installs: false }), install: vi.fn() };
    const { instance } = updater({ fetch: feed.fetch, installer, window });
    expect((await instance.install()).phase).toBe("installed");
    expect(installed).toHaveLength(1);
    expect(window.install).not.toHaveBeenCalled();
  });

  it("says why a copy cannot update itself, and refuses Update now", async () => {
    const feed = fakeFeed("0.7.14");
    const { instance } = updater({ fetch: feed.fetch, unsupported: "This Tau runs from a checkout." });
    expect(instance.status()).toMatchObject({ phase: "unsupported", installer: "none", reason: "This Tau runs from a checkout." });
    await expect(instance.install()).rejects.toThrow(/checkout/u);
    expect(feed.fetch).not.toHaveBeenCalled();
  });

  it("keeps the download when the installer is blocked, with the reason", async () => {
    const feed = fakeFeed("0.7.14");
    let blocked: string | undefined;
    const { installer, installed } = fakeInstaller({ blocked: async () => blocked });
    const { instance } = updater({ fetch: feed.fetch, installer });
    instance.updateSettings({ automatic: false });
    await instance.check();
    // Blocked before the download: nothing is fetched.
    blocked = "Installing needs an administrator.";
    expect(await instance.install()).toMatchObject({ phase: "available", reason: "Installing needs an administrator." });
    expect(installed).toHaveLength(0);
    blocked = undefined;
    expect((await instance.install()).phase).toBe("installed");
  });

  it("does not retry a failed install on its own", async () => {
    const feed = fakeFeed("0.7.14");
    const install = vi.fn(async () => { throw new Error("polkit did not allow the update helper; nothing was installed."); });
    const { installer } = fakeInstaller({ install });
    const { instance, advance } = updater({ fetch: feed.fetch, installer });
    advance(120_000);
    expect((await instance.check()).phase).toBe("failed");
    instance.observe({ type: "agent-status", sessionId: "a", running: true });
    advance(120_000);
    instance.observe({ type: "agent-status", sessionId: "a", running: false });
    await instance.check();
    expect(install).toHaveBeenCalledOnce();
  });
});

describe("update methods", () => {
  const device = { ...NO_JOB_CONTEXT, principal: { kind: "workbench-client" as const, connection: "c1", pairedClient: "phone" } };
  const owner = { ...NO_JOB_CONTEXT, principal: { kind: "workbench-client" as const, connection: "c0", local: true as const } };

  it("lets a paired device install only while the owner allows it, and only the owner changes that", async () => {
    const feed = fakeFeed("0.7.14");
    const { installer, installed } = fakeInstaller();
    const { instance } = updater({ fetch: feed.fetch, installer });
    const methods = createUpdateMethods(() => instance);
    await expect(methods["update-settings"]!([{ devicesMayInstall: false }], device)).rejects.toMatchObject({ code: "forbidden" });
    await methods["update-settings"]!([{ devicesMayInstall: false }], owner);
    await expect(methods["update-install"]!([], device)).rejects.toMatchObject({ code: "forbidden" });
    expect(installed).toHaveLength(0);
    // A device may still turn automatic updates on or off.
    expect(await methods["update-settings"]!([{ automatic: false }], device)).toMatchObject({ automatic: false, devicesMayInstall: false });
    await methods["update-settings"]!([{ devicesMayInstall: true }], owner);
    expect(await methods["update-install"]!([], device)).toMatchObject({ phase: "installed" });
    await expect(methods["update-settings"]!([{ automatic: "yes" }], owner)).rejects.toMatchObject({ code: "invalid-request" });
  });

  it("answers unsupported on a host without an updater, which an older client already handles", async () => {
    const methods = createUpdateMethods(() => undefined);
    await expect(methods["update-status"]!([], owner)).rejects.toMatchObject({ code: "unsupported" });
  });

  it("asks only a window on this machine, through core's window half", async () => {
    const call = vi.fn(async (_id: string, command: string) => command === "update-state" ? { installs: true, downloaded: "0.7.14" } : { started: true });
    const port = localWindowUpdatePort({ call, hasLocalWindow: () => true } as never);
    expect(await port.state()).toEqual({ installs: true, downloaded: "0.7.14" });
    expect(await port.install()).toEqual({ started: true });
    expect(call).toHaveBeenCalledWith("window", "update-state", undefined, { window: "host", timeoutMs: 10_000 });
  });
});
