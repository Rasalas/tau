import { generateKeyPairSync, createHash, sign } from "node:crypto";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { afterEach, expect, it } from "vitest";
import { portableBootstrapScript, prepareManagedHostRelease } from "./managed-host-release.js";

const scratch: string[] = [];
const dir = () => { const path = mkdtempSync(join(tmpdir(), "tau-managed-release-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });
const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const digest = (bytes: Buffer) => createHash("sha512").update(bytes).digest("base64");

function feed(bytes: Buffer, file = "Tau-host-1.2.3-linux-x64.tar.gz", signature?: string) {
  const text = `version: 1.2.3\nfiles:\n  - url: ${file}\n    sha512: ${digest(bytes)}\n    size: ${bytes.length}\n`;
  const calls: string[] = [];
  return { calls, fetch: async (url: string) => {
    calls.push(url);
    return new Response(url.endsWith(".sig") ? signature ?? sign(null, Buffer.from(text), keys.privateKey).toString("base64") : url.endsWith(".yml") ? text : new Uint8Array(bytes));
  } };
}

it("checks the signed platform manifest and archive before preserving a download", async () => {
  const bytes = Buffer.from("portable archive"); const fixture = feed(bytes);
  const release = await prepareManagedHostRelease("linux", "x64", dir(), undefined, fixture.fetch, [publicKey]);
  expect(readFileSync(release.path)).toEqual(bytes);
  expect(fixture.calls.at(-1)).toContain("/download/v1.2.3/Tau-host-1.2.3-linux-x64.tar.gz");
});

it("refuses tampered signatures, wrong platforms and path-bearing artifact names before download", async () => {
  for (const fixture of [feed(Buffer.from("x"), undefined, Buffer.alloc(64).toString("base64")), feed(Buffer.from("x"), "Tau-host-1.2.3-darwin-arm64.tar.gz"), feed(Buffer.from("x"), "../Tau-host-1.2.3-linux-x64.tar.gz")]) {
    await expect(prepareManagedHostRelease("linux", "x64", dir(), undefined, fixture.fetch, [publicKey])).rejects.toThrow();
    expect(fixture.calls.every((url) => url.endsWith(".yml") || url.endsWith(".sig"))).toBe(true);
  }
});

it("discards a damaged archive and its partial file", async () => {
  const fixture = feed(Buffer.from("expected")); const cache = dir();
  await expect(prepareManagedHostRelease("linux", "x64", cache, undefined, async (url) => url.endsWith(".yml") || url.endsWith(".sig") ? fixture.fetch(url) : new Response("damaged"), [publicKey])).rejects.toThrow(/checksum/u);
  expect(existsSync(join(cache, "Tau-host-1.2.3-linux-x64.tar.gz"))).toBe(false);
  expect(existsSync(join(cache, "Tau-host-1.2.3-linux-x64.tar.gz.part"))).toBe(false);
});

it("rejects non-release versions before building shell or filesystem paths", () => {
  for (const version of [".", "..", "../outside", "1;echo secret", "nightly"]) expect(() => portableBootstrapScript("linux", version, digest(Buffer.from("x")))).toThrow();
});

it("extracts into a private version directory and replaces an existing current symlink atomically", () => {
  if (process.platform !== "linux") return;
  const folder = dir(); const packed = join(folder, "packed"); mkdirSync(packed);
  writeFileSync(join(packed, "tau"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const archive = join(folder, "archive.tar.gz"); execFileSync("tar", ["-czf", archive, "-C", packed, "."]);
  const root = join(folder, "managed");
  for (let i = 0; i < 2; i++) execFileSync("sh", ["-c", portableBootstrapScript("linux", "1.2.3", digest(readFileSync(archive))), "test", archive, root]);
  expect(realpathSync(join(root, "current"))).toBe(join(root, "releases", "1.2.3"));
});

it("rejects archive traversal before extracting or installing anything", () => {
  const folder = dir();
  // A minimal tar member, so no local tar implementation normalizes the hostile name.
  const header = Buffer.alloc(512); header.write("../../escape"); header.write("0000644\0", 100); header.write("0000000\0", 108); header.write("0000000\0", 116); header.write("00000000000\0", 124); header.write("00000000000\0", 136); header.fill(32, 148, 156); header[156] = 48;
  const sum = header.reduce((value, byte) => value + byte, 0); header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const bytes = gzipSync(Buffer.concat([header, Buffer.alloc(1024)])); const archive = join(folder, "bad.tar.gz"); writeFileSync(archive, bytes);
  expect(() => execFileSync("sh", ["-c", portableBootstrapScript("linux", "1.2.3", digest(bytes)), "test", archive, join(folder, "managed")], { stdio: "pipe" })).toThrow();
  expect(existsSync(join(folder, "managed"))).toBe(false);
});
