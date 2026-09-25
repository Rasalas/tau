import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { BUILD_ONLY_DEV_DEPENDENCIES, collectThirdPartyLicenses } from "./vite.third-party-licenses";
import { packLicenses, unpackLicenses } from "./src/shared/third-party-licenses";

let root: string | undefined;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = undefined; });

async function pkg(directory: string, manifest: Record<string, unknown>, license?: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
  if (license) await writeFile(join(directory, "LICENSE"), license);
}

describe("the packages Tau ships", () => {
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
