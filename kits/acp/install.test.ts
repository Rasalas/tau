import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { c as tar } from "tar";
import { afterEach, expect, it, vi } from "vitest";
import { installBinary } from "./install.js";
import type { RegistryAgent } from "./protocol.js";
const folders: string[] = [];
afterEach(async () => { for (const path of folders.splice(0)) await rm(path, { recursive: true, force: true }); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-acp-install-")); folders.push(root);
  await mkdir(join(root, "source")); await writeFile(join(root, "source", "agent"), "#!/bin/sh\nexit 0\n");
  await tar({ cwd: join(root, "source"), file: join(root, "archive.tgz"), gzip: true }, ["agent"]);
  const bytes = await readFile(join(root, "archive.tgz"));
  const agent: RegistryAgent = { id: "example", name: "Example", version: "1.0.0", description: "Test", distribution: { binary: { "linux-x86_64": { archive: "https://example.test/agent.tgz", sha256: createHash("sha256").update(bytes).digest("hex"), cmd: "./agent", args: ["--acp"] } } } };
  const fetcher = vi.fn(async () => new Response(bytes)) as unknown as typeof fetch;
  return { root, bytes, agent, fetcher };
}
it("checks and privately installs a registry archive without running it", async () => {
  const f = await fixture();
  const config = await installBinary(f.agent, join(f.root, "state"), f.fetcher, "linux", "x64");
  expect(config.command).toContain(join("tools", "example"));
  expect(config.args).toEqual(["--acp"]);
  expect(await readFile(config.command, "utf8")).toContain("exit 0");
  expect((await installBinary(f.agent, join(f.root, "state"), f.fetcher, "linux", "x64")).command).toBe(config.command);
});
it("rejects corrupt downloads, missing checksums and unsupported platforms", async () => {
  const f = await fixture();
  f.agent.distribution.binary!["linux-x86_64"]!.sha256 = "0".repeat(64);
  await expect(installBinary(f.agent, f.root, f.fetcher, "linux", "x64")).rejects.toThrow(/SHA-256/u);
  delete f.agent.distribution.binary!["linux-x86_64"]!.sha256;
  await expect(installBinary(f.agent, f.root, f.fetcher, "linux", "x64")).rejects.toThrow(/no SHA-256/u);
  await expect(installBinary(f.agent, f.root, f.fetcher, "win32", "arm64")).rejects.toThrow(/no binary/u);
});
