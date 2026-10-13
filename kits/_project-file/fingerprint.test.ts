import { describe, expect, it } from "vitest";
import { setupFingerprint } from "./fingerprint.js";

const definitions = {
  workspaceMode: "worktree", worktreeDirectory: "../worktrees", runOnWorktreeCreate: "legacy",
  scripts: [{ name: "Install", command: "npm ci", runOnWorktreeCreate: true, async: false }],
};
const hash = (value: unknown) => setupFingerprint(JSON.stringify(value));

describe("project setup fingerprint", () => {
  it("ignores formatting, object key order and unrelated project metadata", () => {
    const reordered = { ...definitions, iconPath: "icon.svg", scripts: [{ async: false, runOnWorktreeCreate: true, command: "npm ci", name: "Install" }] };
    expect(setupFingerprint(JSON.stringify(reordered, null, 2))).toBe(hash(definitions));
  });

  it.each([
    { workspaceMode: "current" }, { worktreeDirectory: "../elsewhere" },
    { runOnWorktreeCreate: "replacement" },
    { scripts: [{ ...definitions.scripts[0], command: "replacement" }] },
    { scripts: [{ ...definitions.scripts[0], runOnWorktreeCreate: false }] },
    { scripts: [{ ...definitions.scripts[0], async: true }] },
  ])("invalidates approval when definitions change: %j", (change) => {
    expect(hash({ ...definitions, ...change })).not.toBe(hash(definitions));
  });
});
