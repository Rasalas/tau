import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { warnAboutStaleKits } from "./bundled-kits.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function checkout(sourceAgeMs: number, prebuiltAgeMs: number | undefined): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-kits-"));
  directories.push(root);
  const write = async (directory: string, name: string, ageMs: number) => {
    await mkdir(join(root, directory, "tau.example"), { recursive: true });
    const file = join(root, directory, "tau.example", name);
    await writeFile(file, "//", "utf8");
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  };
  await write("kits", "host.ts", sourceAgeMs);
  if (prebuiltAgeMs !== undefined) await write("dist-kits", "host.cjs", prebuiltAgeMs);
  return root;
}

describe("stale prebuilt kits", () => {
  it("warns once when a kit source is newer than the prebuilt distribution", async () => {
    const messages: string[] = [];
    const root = await checkout(1_000, 10_000);
    await warnAboutStaleKits(root, (label) => messages.push(label));
    // A workspace switch reloads the kits; the warning is about the checkout, not the load.
    await warnAboutStaleKits(root, (label) => messages.push(label));
    expect(messages).toEqual(["host-extension.kits.stale"]);
  });

  it("stays quiet for a fresh build, and for an installed app without sources", async () => {
    const messages: string[] = [];
    await warnAboutStaleKits(await checkout(10_000, 1_000), (label) => messages.push(label));
    await warnAboutStaleKits(await checkout(1_000, undefined), (label) => messages.push(label));
    expect(messages).toEqual([]);
  });
});
