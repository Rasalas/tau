import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createAppearanceHostExtension from "./host.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "tau-appearance-host-"));
  directories.push(root);
  const themesDir = join(root, "themes");
  const registry = await activateHostKit(createAppearanceHostExtension() as unknown as HostExtension, { themesDir });
  return { themesDir, save: (input: unknown) => registry.invoke("tau.appearance", "save-theme", input) };
}

describe("the Appearance Kit's host half", () => {
  it("writes a theme into the user's themes folder as one .css file", async () => {
    const { themesDir, save } = await harness();
    const result = await save({ id: "ember", name: "Ember", appearance: "dark", tokens: { "--shell": "#1a1010", "--acid": "#ff6a00" } });
    expect(result).toEqual({ id: "ember", path: join(themesDir, "ember.css") });
    expect(await readdir(themesDir)).toEqual(["ember.css"]);
    const css = await readFile(join(themesDir, "ember.css"), "utf8");
    expect(css).toContain("color-scheme: dark;");
    expect(css).toContain("--acid: #ff6a00;");
  });

  it("refuses a name that leaves the folder, an unknown token or a value that is no colour", async () => {
    const { themesDir, save } = await harness();
    // A refusal answers rather than throws, so a user's mistakes never stop the kit.
    expect(await save({ id: "../escape", name: "x", appearance: "dark", tokens: { "--shell": "#000" } })).toEqual({ error: expect.stringMatching(/letters or digits/u) });
    expect(await save({ id: "x", name: "x", appearance: "dark", tokens: { "--space-4": "#000" } })).toEqual({ error: expect.stringMatching(/not a colour token/u) });
    expect(await save({ id: "x", name: "x", appearance: "dark", tokens: { "--shell": "url(x)" } })).toEqual({ error: expect.stringMatching(/needs a colour/u) });
    expect(await save({ id: "x", name: "x", appearance: "dim", tokens: { "--shell": "#000" } })).toEqual({ error: expect.stringMatching(/light or dark/u) });
    await expect(readdir(themesDir)).rejects.toThrow();
  });
});
