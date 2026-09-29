import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_ONLY_DEV_DEPENDENCIES, bundledFileLicenses, collectMobileLicenses, collectThirdPartyLicenses, SUPPLIED_LICENSES_DIR } from "./vite.third-party-licenses";
import { packLicenses, unpackLicenses } from "./src/shared/third-party-licenses";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function pkg(directory: string, manifest: Record<string, unknown>, license?: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  if (license) await writeFile(join(directory, "LICENSE"), license);
}

describe("the packages Tau ships", () => {
  it("names the interface font it bundles, with the font's own licence", () => {
    const [figtree] = bundledFileLicenses(fileURLToPath(new URL(".", import.meta.url)));
    expect(figtree).toMatchObject({ name: "Figtree", license: "OFL-1.1" });
    expect(figtree?.text).toMatch(/Copyright 2022 The Figtree Project Authors[\s\S]*SIL OPEN FONT LICENSE Version 1\.1/u);
  });

  it("walks dependencies and bundled devDependencies as Node resolves them, never build tools", async () => {
    root = await mkdtemp(join(tmpdir(), "tau-licenses-"));
    const modules = join(root, "node_modules");
    await pkg(root, { dependencies: { react: "1" }, devDependencies: { "@xterm/xterm": "5", vitest: "3", electron: "40" } });
    await pkg(join(modules, "react"), { name: "react", version: "19.0.0", license: "MIT", repository: "github:facebook/react", dependencies: { scheduler: "1" } }, "MIT License\n\nCopyright Meta");
    await pkg(join(modules, "scheduler"), { name: "scheduler", version: "0.1.0", licenses: [{ type: "MIT" }] }, "MIT License\n\nCopyright Meta");
    // A nested copy wins for the package that depends on it.
    await pkg(join(modules, "@xterm/xterm"), { name: "@xterm/xterm", version: "5.5.0", license: "MIT", repository: { url: "git+https://github.com/xtermjs/xterm.js.git" }, dependencies: { scheduler: "2" } });
    await pkg(join(modules, "@xterm/xterm/node_modules/scheduler"), { name: "scheduler", version: "0.2.0", license: "MIT" });
    await pkg(join(modules, "vitest"), { name: "vitest", version: "3.2.4", license: "MIT" });
    await pkg(join(modules, "electron"), { name: "electron", version: "40.0.0", license: "MIT", dependencies: { "@electron/get": "1" } });
    await pkg(join(modules, "@electron/get"), { name: "@electron/get", version: "1.0.0", license: "MIT" });

    const found = collectThirdPartyLicenses(root);
    expect(found.map((entry) => `${entry.name}@${entry.version}`)).toEqual([
      "@xterm/xterm@5.5.0", "electron@40.0.0", "react@19.0.0", "scheduler@0.1.0", "scheduler@0.2.0",
    ]);
    expect(found.find((entry) => entry.name === "react")).toEqual({
      name: "react", version: "19.0.0", license: "MIT", repository: "https://github.com/facebook/react", text: "MIT License\n\nCopyright Meta",
    });
    expect(found.find((entry) => entry.name === "@xterm/xterm")?.repository).toBe("https://github.com/xtermjs/xterm.js");
  });

  it("gives a package without a licence file its repository's text, a supplied one, or MIT's own words", async () => {
    root = await mkdtemp(join(tmpdir(), "tau-licenses-"));
    const modules = join(root, "node_modules");
    await pkg(root, { dependencies: { tool: "1", "tool-darwin": "1", agent: "1", tiny: "1", odd: "1" } });
    await pkg(join(modules, "tool"), { name: "tool", version: "1.0.0", license: "MIT", repository: "github:someone/tool" }, "MIT License\n\nCopyright Someone");
    await pkg(join(modules, "tool-darwin"), { name: "tool-darwin", version: "1.0.0", license: "MIT", repository: "github:someone/tool" });
    await pkg(join(modules, "agent"), { name: "agent", version: "2.0.0", license: "MIT", repository: { url: "git+https://github.com/Some-Org/Agent.git" } });
    await pkg(join(modules, "tiny"), { name: "tiny", version: "0.1.0", license: "MIT", author: "Ada Lovelace <ada@example.invalid> (https://example.invalid)" });
    await pkg(join(modules, "odd"), { name: "odd", version: "0.1.0", license: "BSD-3-Clause" });
    await mkdir(join(root, SUPPLIED_LICENSES_DIR), { recursive: true });
    await writeFile(join(root, SUPPLIED_LICENSES_DIR, "some-org__agent.txt"), "MIT License\n\nCopyright (c) 2025 Some Org\n");

    const text = (name: string) => collectThirdPartyLicenses(root!).find((entry) => entry.name === name)?.text;
    expect(text("tool-darwin")).toBe("MIT License\n\nCopyright Someone");
    expect(text("agent")).toBe("MIT License\n\nCopyright (c) 2025 Some Org");
    expect(text("tiny")).toMatch(/^MIT License\n\nCopyright \(c\) Ada Lovelace\n\nPermission is hereby granted/u);
    expect(text("odd")).toBeUndefined();
  });

  it("carries the texts Pi and the vendored programs ship without", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const pi = collectThirdPartyLicenses(here).find((entry) => entry.name === "@earendil-works/pi-coding-agent");
    expect(pi?.text).toMatch(/Copyright \(c\) 2025 Mario Zechner/u);
    for (const file of ["microsoft__terminal.txt", "trycua__cua.txt"]) {
      expect(readFileSync(join(here, SUPPLIED_LICENSES_DIR, file), "utf8")).toMatch(/^(?:MIT License|Copyright)/u);
    }
  });

  // The mobile app's packages are installed only where it is built.
  it.skipIf(!existsSync(fileURLToPath(new URL("./mobile/node_modules/@capacitor/core", import.meta.url))))("lists for the mobile app what its bundle reaches, not the desktop app's packages", () => {
    const found = collectMobileLicenses(fileURLToPath(new URL(".", import.meta.url)));
    const names = new Set(found.map((entry) => entry.name));
    expect(names.has("@capacitor/core")).toBe(true);
    expect(names.has("react")).toBe(true);
    for (const desktopOnly of ["electron", "node-pty", "@earendil-works/pi-coding-agent", "tau-native"]) expect(names.has(desktopOnly)).toBe(false);
  });

  it("stores a notice once however many packages carry it", () => {
    const packed = packLicenses([
      { name: "a", version: "1.0.0", license: "MIT", text: "same" },
      { name: "b", version: "1.0.0", license: "MIT", text: "same" },
      { name: "c", version: "1.0.0", license: "ISC" },
    ]);
    expect(packed.texts).toEqual(["same"]);
    expect(unpackLicenses(JSON.parse(JSON.stringify(packed))).map((entry) => entry.text)).toEqual(["same", "same", undefined]);
    expect(unpackLicenses({ packages: [{ name: 1 }, { name: "x", version: "1", repository: "javascript:alert(1)" }] })).toEqual([{ name: "x", version: "1", license: "UNKNOWN" }]);
  });

  it("lists what the Servers kit ships and leaves out its test fakes", () => {
    const found = collectThirdPartyLicenses(fileURLToPath(new URL(".", import.meta.url)));
    const license = (name: string) => found.find((entry) => entry.name === name)?.license;
    expect(license("basic-ftp")).toBe("MIT");
    expect(license("@anthropic-ai/sandbox-runtime")).toBe("Apache-2.0");
    expect(found.some((entry) => entry.name === "ssh2" || entry.name === "ftp-srv")).toBe(false);
  });

  it("names only devDependencies this repository has", async () => {
    const manifest = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8")) as { devDependencies: Record<string, string> };
    expect([...BUILD_ONLY_DEV_DEPENDENCIES].filter((name) => !(name in manifest.devDependencies))).toEqual([]);
  });
});
