import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { portableHost, findPortableRoot } from "./portable-host.mjs";

const scratch = [];
const folder = () => { const path = mkdtempSync(join(tmpdir(), "tau-portable-package-")); scratch.push(path); return path; };
afterEach(() => { for (const path of scratch.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("packages the actual app directory and writes an architecture-specific SHA-512 feed", () => {
  const root = folder(); const out = folder(); writeFileSync(join(root, "tau"), "fake executable", { mode: 0o755 });
  mkdirSync(join(root, "resources")); writeFileSync(join(root, "resources", "app.asar"), "app contents");
  const archive = portableHost({ root, out, platform: "linux", arch: "arm64", version: "1.2.3" });
  const sha512 = createHash("sha512").update(readFileSync(archive)).digest("base64");
  expect(readFileSync(join(out, "latest-host-linux-arm64.yml"), "utf8")).toContain(`sha512: ${sha512}`);
  expect(archive).toContain("Tau-host-1.2.3-linux-arm64.tar.gz");
});

it("refuses external symlinks and unsafe release versions before creating an archive", () => {
  const root = folder(); const out = folder(); const external = folder(); writeFileSync(join(root, "tau"), "fake executable");
  symlinkSync(external, join(root, "outside")); const run = vi.fn();
  expect(() => portableHost({ root, out, platform: "linux", arch: "x64", version: "1.2.3", run })).toThrow(/outside/u);
  expect(() => portableHost({ root, out, platform: "linux", arch: "x64", version: "..", run })).toThrow();
  expect(run).not.toHaveBeenCalled();
});

it("selects the requested Mac app architecture and refuses an ambiguous app directory", () => {
  const root = folder(); for (const name of ["mac", "mac-arm64"]) mkdirSync(join(root, name, "Tau.app"), { recursive: true });
  expect(findPortableRoot(root, "darwin", "arm64")).toBe(join(root, "mac-arm64"));
  expect(findPortableRoot(root, "darwin", "x64")).toBe(join(root, "mac"));
  mkdirSync(join(root, "second", "Tau.app"), { recursive: true }); expect(() => findPortableRoot(root, "darwin", "x64")).toThrow(/Expected one/u);
});
