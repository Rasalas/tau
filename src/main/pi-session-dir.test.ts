import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { resolvePiSessionsDirOverride } from "./pi-session-dir.js";

describe("resolvePiSessionsDirOverride", () => {
  it("is undefined when PI_CODING_AGENT_SESSION_DIR is unset", () => {
    expect(resolvePiSessionsDirOverride({})).toBeUndefined();
  });

  it("resolves an absolute path as-is", () => {
    expect(resolvePiSessionsDirOverride({ PI_CODING_AGENT_SESSION_DIR: "/tmp/tau-dev/pi-sessions" }))
      .toBe("/tmp/tau-dev/pi-sessions");
  });

  it("resolves a relative path against the current working directory", () => {
    expect(resolvePiSessionsDirOverride({ PI_CODING_AGENT_SESSION_DIR: "relative/pi-sessions" }))
      .toBe(join(process.cwd(), "relative/pi-sessions"));
  });

  it("expands a leading ~ the way Pi's own CLI flag does", () => {
    expect(resolvePiSessionsDirOverride({ PI_CODING_AGENT_SESSION_DIR: "~/tau-dev/pi-sessions" }))
      .toBe(join(homedir(), "tau-dev/pi-sessions"));
    expect(resolvePiSessionsDirOverride({ PI_CODING_AGENT_SESSION_DIR: "~" })).toBe(homedir());
  });

  it("ignores an empty string, the same as unset", () => {
    expect(resolvePiSessionsDirOverride({ PI_CODING_AGENT_SESSION_DIR: "" })).toBeUndefined();
  });
});
