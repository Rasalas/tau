import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fixNodePty, patchAsarRewrite } from "./fix-node-pty.mjs";

const UNIX = "helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');\nhelperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');\n";

describe("fix-node-pty", () => {
  it("maps a packed path once and leaves an unpacked one alone", () => {
    const patched = patchAsarRewrite(UNIX);
    // eslint-disable-next-line no-new-func
    const run = (helperPath) => new Function("helperPath", `${patched}return helperPath;`)(helperPath);
    expect(run("/A/Tau.app/Contents/Resources/app.asar/node_modules/node-pty/build/spawn-helper"))
      .toBe("/A/Tau.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/build/spawn-helper");
    expect(run("/A/Tau.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper"))
      .toBe("/A/Tau.app/Contents/Resources/app.asar.unpacked/node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper");
    expect(patchAsarRewrite(patched)).toBe(patched);
  });

  it("patches the installed files and restores spawn-helper's execute bit", () => {
    const root = mkdtempSync(join(tmpdir(), "node-pty-fix-"));
    mkdirSync(join(root, "lib"));
    mkdirSync(join(root, "prebuilds", "darwin-arm64"), { recursive: true });
    writeFileSync(join(root, "lib", "unixTerminal.js"), UNIX);
    writeFileSync(join(root, "prebuilds", "darwin-arm64", "spawn-helper"), "", { mode: 0o644 });
    fixNodePty(root);
    expect(readFileSync(join(root, "lib", "unixTerminal.js"), "utf8")).not.toContain(".replace('app.asar'");
    expect(statSync(join(root, "prebuilds", "darwin-arm64", "spawn-helper")).mode & 0o111).not.toBe(0);
  });
});
