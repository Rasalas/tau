import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { RELEASE_PUBLIC_KEYS as APP_KEYS } from "../src/shared/release-keys.ts";
import { EXIT, RELEASE_PUBLIC_KEYS, compareVersions, installUpdate, parseArgs, readFeed, releaseBase } from "./tau-update-helper.mjs";

const PACKAGE = Buffer.from("tau 0.7.14 for amd64");
const SHA512 = createHash("sha512").update(PACKAGE).digest("base64");
const FEED_TEXT = `version: 0.7.14\nfiles:\n  - url: Tau-0.7.14.AppImage\n    sha512: x\n  - url: Tau_0.7.14_amd64.deb\n    sha512: ${SHA512}\n    size: ${PACKAGE.length}\n`;

/** The machine as the helper sees it; each part can be changed to what an attacker would hand it. */
function machine(overrides = {}) {
  const runs = [];
  const fetched = [];
  const fields = overrides.fields ?? "Package: tau\nVersion: 0.7.14\nArchitecture: amd64\n";
  const system = {
    isRoot: () => overrides.root ?? true,
    config: () => overrides.config === undefined ? { owner: "Rasalas", repo: "tau" } : overrides.config,
    run: vi.fn(async (command, args, env) => {
      runs.push({ command, args, env });
      if (command === "dpkg") return { code: 0, stdout: "amd64\n", stderr: "" };
      if (command === "dpkg-query") return { code: 0, stdout: overrides.installed ?? "0.7.6", stderr: "" };
      if (command === "dpkg-deb") return { code: 0, stdout: fields, stderr: "" };
      return { code: overrides.aptCode ?? 0, stdout: "", stderr: overrides.aptCode ? "E: broken\n" : "" };
    }),
    fetch: vi.fn(async (url) => {
      fetched.push(url);
      if (url.endsWith(".sig")) return overrides.signature ? new Response(overrides.signature) : new Response("", { status: 404 });
      return new Response(overrides.feed ?? FEED_TEXT);
    }),
    tempFolder: () => "/tmp/tau-update-X",
    removeFolder: vi.fn(),
    receive: vi.fn(async (_target, limit) => {
      const bytes = overrides.stdin ?? PACKAGE;
      if (bytes.length > limit) throw Object.assign(new Error("too large"), { code: EXIT.refused });
      return { size: bytes.length, sha512: createHash("sha512").update(bytes).digest("base64") };
    }),
  };
  return { system, runs, fetched };
}

const ARGS = ["install", "--version", "0.7.14", "--channel", "stable"];
const apt = (runs) => runs.find((entry) => entry.command === "apt-get");

describe("tau-update-helper", () => {
  it("installs the package it reads when it is the release's, newer, and tau for this architecture", async () => {
    const { system, runs, fetched } = machine();
    await expect(installUpdate({ argv: ARGS, system, keys: [] })).resolves.toEqual({ version: "0.7.14", installed: "0.7.6" });
    // The feed is the release of exactly that version, from the app's own repository.
    expect(fetched).toEqual(["https://github.com/Rasalas/tau/releases/download/v0.7.14/latest-linux.yml"]);
    expect(apt(runs)).toMatchObject({ args: ["install", "-y", "--no-install-recommends", "-o", "DPkg::Lock::Timeout=120", "/tmp/tau-update-X/tau.deb"], env: { DEBIAN_FRONTEND: "noninteractive" } });
    expect(system.receive).toHaveBeenCalledWith("/tmp/tau-update-X/tau.deb", PACKAGE.length);
    expect(system.removeFolder).toHaveBeenCalledWith("/tmp/tau-update-X");
  });

  it("takes no path, no URL and nothing but a version and a channel", () => {
    for (const argv of [
      [],
      ["install"],
      ["remove", "--version", "0.7.14"],
      ["install", "--version", "0.7.14", "--file", "/tmp/evil.deb"],
      ["install", "--version", "../../evil"],
      ["install", "--version", "0.7.14; rm -rf /"],
      ["install", "--version", "0.7.14", "--channel", "http://evil"],
      ["install", "--version", "0.7.14", "--version", "0.7.15"],
      ["install", "--version", "0.7.14", "--channel", "nightly"],
    ]) expect(() => parseArgs(argv), argv.join(" ")).toThrow(expect.objectContaining({ code: EXIT.usage }));
    expect(parseArgs(["install", "--version", "0.7.15-nightly.20260929.3", "--channel", "nightly"])).toEqual({ version: "0.7.15-nightly.20260929.3", channel: "nightly" });
  });

  it("refuses a package whose checksum or size does not match the release", async () => {
    const tampered = Buffer.from(PACKAGE);
    tampered[0] ^= 1;
    const { system, runs } = machine({ stdin: tampered });
    await expect(installUpdate({ argv: ARGS, system, keys: [] })).rejects.toMatchObject({ code: EXIT.refused, message: expect.stringMatching(/checksum/u) });
    expect(apt(runs)).toBeUndefined();
    expect(system.removeFolder).toHaveBeenCalled();
    const larger = machine({ stdin: Buffer.concat([PACKAGE, Buffer.from(" and more")]) });
    await expect(installUpdate({ argv: ARGS, system: larger.system, keys: [] })).rejects.toMatchObject({ code: EXIT.refused });
    expect(apt(larger.runs)).toBeUndefined();
  });

  it("refuses another package, another architecture or another version behind a matching checksum", async () => {
    await Promise.all(["Package: evil\nVersion: 0.7.14\nArchitecture: amd64\n", "Package: tau\nVersion: 0.7.14\nArchitecture: arm64\n", "Package: tau\nVersion: 0.7.13\nArchitecture: amd64\n"].map(async (fields) => {
      const { system, runs } = machine({ fields });
      await expect(installUpdate({ argv: ARGS, system, keys: [] })).rejects.toMatchObject({ code: EXIT.refused });
      expect(apt(runs)).toBeUndefined();
    }));
  });

  it("never goes back or sideways", async () => {
    await Promise.all(["0.7.14", "0.7.15", "0.7.15~nightly.20260929.3"].map(async (installed) => {
      const { system, runs } = machine({ installed });
      await expect(installUpdate({ argv: ARGS, system, keys: [] })).rejects.toMatchObject({ code: EXIT.notNewer });
      expect(apt(runs)).toBeUndefined();
    }));
  });

  it("refuses when the release names another version than the one asked for", async () => {
    const { system } = machine({ feed: FEED_TEXT.replace("version: 0.7.14", "version: 0.7.13") });
    await expect(installUpdate({ argv: ARGS, system, keys: [] })).rejects.toMatchObject({ code: EXIT.refused });
  });

  it("requires the release key's signature once it carries a key", async () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
    const forged = sign(null, Buffer.from(FEED_TEXT), generateKeyPairSync("ed25519").privateKey).toString("base64");
    await Promise.all([undefined, forged].map(async (signature) => {
      const { system, runs } = machine(signature ? { signature } : {});
      await expect(installUpdate({ argv: ARGS, system, keys: [raw] })).rejects.toMatchObject({ code: EXIT.refused, message: expect.stringMatching(/release key/u) });
      expect(system.receive).not.toHaveBeenCalled();
      expect(apt(runs)).toBeUndefined();
    }));
    const { system } = machine({ signature: sign(null, Buffer.from(FEED_TEXT), privateKey).toString("base64") });
    await expect(installUpdate({ argv: ARGS, system, keys: [raw] })).resolves.toMatchObject({ version: "0.7.14" });
  });

  it("runs only as root, only where tau is installed, and reports apt's failure", async () => {
    await expect(installUpdate({ argv: ARGS, system: machine({ root: false }).system, keys: [] })).rejects.toMatchObject({ code: EXIT.notRoot });
    await expect(installUpdate({ argv: ARGS, system: machine({ installed: "" }).system, keys: [] })).rejects.toMatchObject({ code: EXIT.refused });
    await expect(installUpdate({ argv: ARGS, system: machine({ config: null }).system, keys: [] })).rejects.toMatchObject({ code: EXIT.feed });
    await expect(installUpdate({ argv: ARGS, system: machine({ aptCode: 100 }).system, keys: [] })).rejects.toMatchObject({ code: EXIT.install, message: expect.stringMatching(/E: broken/u) });
  });

  it("reads the release folder from the app's feed or an administrator's mirror", () => {
    expect(readFeed("provider: github\nowner: Rasalas\nrepo: tau\n")).toEqual({ owner: "Rasalas", repo: "tau" });
    expect(readFeed("provider: github\nowner: ../x\nrepo: tau\n")).toBeUndefined();
    expect(releaseBase({ owner: "Rasalas", repo: "tau" }, "0.7.15-nightly.20260929.3", "nightly")).toBe("https://github.com/Rasalas/tau/releases/download/nightly/");
    expect(releaseBase({ feedUrl: "http://mirror.lan/tau" }, "0.7.14", "stable")).toBe("http://mirror.lan/tau/");
  });

  it("orders versions the way dpkg does for Tau's", () => {
    expect(compareVersions("0.7.14", "0.7.6")).toBe(1);
    expect(compareVersions("0.7.15-nightly.20260929.3", "0.7.14")).toBe(1);
    expect(compareVersions("0.7.15~nightly.20260929.3", "0.7.15")).toBe(-1);
  });

  it("trusts the same release keys as the app", () => {
    expect(RELEASE_PUBLIC_KEYS).toEqual(APP_KEYS);
  });
});
