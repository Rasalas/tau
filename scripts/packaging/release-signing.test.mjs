import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { releasePublicKey, verifyReleaseSignature } from "../../src/main/release-feed.ts";
import { RELEASE_PUBLIC_KEYS } from "../../src/shared/release-keys.ts";
import { verifySignature } from "../../bin/tau-update-helper.mjs";
import { feedText, rawPublicKey, signFeed, signingKeys, verifyFeed } from "./release-signing.mjs";

const SCRIPT = new URL("./release-signing.mjs", import.meta.url).pathname;
const FEED = "version: 0.7.14\nfiles:\n  - url: Tau_0.7.14_amd64.deb\n    sha512: abc==\n    size: 3\npath: Tau_0.7.14_amd64.deb\nreleaseDate: '2026-09-29T10:00:00.000Z'\n";

function keyPair() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return { pem: String(privateKey.export({ format: "pem", type: "pkcs8" })), raw: rawPublicKey(publicKey) };
}

const folders = [];
function folder() {
  const dir = mkdtempSync(join(tmpdir(), "tau-release-signing-"));
  folders.push(dir);
  return dir;
}
afterEach(() => { for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true }); });

const cli = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });

describe("release signing", () => {
  it("signs a feed so the host and the Linux helper both accept it, and only by that key", () => {
    const signer = keyPair();
    const other = keyPair();
    const signature = signFeed(Buffer.from(FEED), signingKeys(signer.pem));
    expect(verifyReleaseSignature(FEED, signature, [signer.raw])).toBe(true);
    expect(verifySignature(FEED, signature, [signer.raw])).toBe(true);
    expect(verifyReleaseSignature(FEED, signature, [other.raw])).toBe(false);
    expect(verifySignature(FEED, signature, [other.raw])).toBe(false);
    expect(verifyReleaseSignature(FEED.replace("0.7.14", "0.7.15"), signature, [signer.raw])).toBe(false);
    expect(verifySignature(FEED.replace("0.7.14", "0.7.15"), signature, [signer.raw])).toBe(false);
  });

  it("signs with every key in the secret, one line each, so a rotation reaches old and new hosts", () => {
    const [oldKey, newKey] = [keyPair(), keyPair()];
    const signature = signFeed(Buffer.from(FEED), signingKeys(`${oldKey.pem}\n${newKey.pem}`));
    expect(signature.trim().split("\n")).toHaveLength(2);
    for (const trusted of [[oldKey.raw], [newKey.raw], [keyPair().raw, newKey.raw]]) {
      expect(verifyReleaseSignature(FEED, signature, trusted)).toBe(true);
      expect(verifySignature(FEED, signature, trusted)).toBe(true);
    }
    expect(verifyReleaseSignature(FEED, signature, [keyPair().raw])).toBe(false);
  });

  it("refuses bytes a host would read differently, and a key that is not Ed25519", () => {
    expect(() => feedText(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(FEED)]))).toThrow(/byte order mark/u);
    expect(() => feedText(Buffer.from([0x76, 0xff, 0x0a]))).toThrow(/not UTF-8/u);
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ format: "pem", type: "pkcs8" });
    expect(() => signingKeys(rsa)).toThrow(/Ed25519/u);
    expect(signingKeys("")).toEqual([]);
  });

  it("ships the release key the secret belongs to, in a form both verifiers read", () => {
    expect(RELEASE_PUBLIC_KEYS).toContain("8hB4AtWuF6uBYObUdffh+1Ib9FMY5S8RCqm0RRp2Smg=");
    for (const key of RELEASE_PUBLIC_KEYS) expect(releasePublicKey(key).asymmetricKeyType).toBe("ed25519");
    // A throwaway key's signature is no release signature.
    const throwaway = keyPair();
    expect(verifyFeed(Buffer.from(FEED), signFeed(Buffer.from(FEED), signingKeys(throwaway.pem)), RELEASE_PUBLIC_KEYS)).toBe(false);
  });

  it("signs, verifies and checks from the command line", () => {
    const dir = folder();
    const signer = keyPair();
    const feeds = ["latest-mac.yml", "latest.yml", "latest-linux.yml"].map((name) => join(dir, name));
    for (const file of feeds) writeFileSync(file, FEED.replace("0.7.14", file.length.toString()));

    const missing = cli(["sign", ...feeds]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/TAU_RELEASE_SIGNING_KEY holds no private key/u);

    const signed = cli(["sign", ...feeds], { TAU_RELEASE_SIGNING_KEY: signer.pem });
    expect(signed.status).toBe(0);
    expect(signed.stdout).not.toContain("PRIVATE KEY");
    for (const file of feeds) expect(verifyReleaseSignature(readFileSync(file, "utf8"), readFileSync(`${file}.sig`, "utf8"), [signer.raw])).toBe(true);

    expect(cli(["verify", feeds[0], `${feeds[0]}.sig`, signer.raw]).status).toBe(0);
    const wrong = cli(["verify", feeds[0], `${feeds[0]}.sig`, keyPair().raw]);
    expect(wrong.status).toBe(1);
    expect(wrong.stderr).toMatch(/not signed by that key/u);

    // `check` holds the files to the keys this checkout ships, which a throwaway key is not.
    rmSync(`${feeds[2]}.sig`);
    const checked = cli(["check", ...feeds]);
    expect(checked.status).toBe(1);
    expect(checked.stderr).toMatch(/latest-mac\.yml: not signed by a key this build trusts/u);
    expect(checked.stderr).toMatch(/latest-linux\.yml: no .*latest-linux\.yml\.sig/u);
  });

  it("makes a key pair once and never overwrites it", () => {
    const target = join(folder(), "release.pem");
    const made = cli(["keygen", target]);
    expect(made.status).toBe(0);
    if (process.platform !== "win32") expect(statSync(target).mode & 0o777).toBe(0o600);
    const raw = /public key:\s+(\S+)/u.exec(made.stdout)?.[1];
    expect(raw).toBe(rawPublicKey(signingKeys(readFileSync(target, "utf8"))[0]));
    expect(cli(["keygen", target]).status).toBe(1);
  });
});
