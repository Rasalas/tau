import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { hostEntryPoints } from "./build-host.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function config(name) {
  const path = fileURLToPath(new URL(`../tooling/${name}`, import.meta.url));
  const read = ts.readConfigFile(path, ts.sys.readFile);
  expect(read.error).toBeUndefined();
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, fileURLToPath(new URL("../tooling", import.meta.url)), undefined, path);
  expect(parsed.errors).toEqual([]);
  return { ...parsed, files: parsed.fileNames.map(file => file.replaceAll("\\", "/").slice(ROOT.replaceAll("\\", "/").length)) };
}

describe("production Electron emit", () => {
  it("leaves test entrypoints in typechecks while omitting them from production output", () => {
    const checked = config("tsconfig.electron.json");
    const emitted = config("tsconfig.electron-build.json");
    const tests = checked.files.filter(file => file.endsWith(".test.ts"));
    expect(tests).toContain("src/main/host-extensions.test.ts");
    expect(emitted.files.filter(file => file.endsWith(".test.ts"))).toEqual([]);
    expect(emitted.files).toEqual(checked.files.filter(file => !file.endsWith(".test.ts")));
    expect(hostEntryPoints()).toEqual(emitted.files);
    expect(emitted.options).toMatchObject({ strict: true, outDir: checked.options.outDir, rootDir: checked.options.rootDir });
  });

  it("still emits preload, workers, shared contracts and helpers used by standalone smoke clients", () => {
    const emitted = config("tsconfig.electron-build.json");
    expect(emitted.files).toEqual(expect.arrayContaining([
      "src/main/headless.ts", "src/main/index.ts", "src/preload/index.cts",
      "src/main/host-extension-worker.ts", "src/shared/contracts.ts",
      "src/main/test-support/push-fakes.ts",
    ]));
  });
});
