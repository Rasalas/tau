import { describe, expect, it } from "vitest";
import { hasManagedMcpConfig, managedMcpConfigPath } from "./managed-mcp.js";

describe("managed-mcp.json", () => {
  it.each([
    ["darwin", "/Library/Application Support/ClaudeCode/managed-mcp.json"],
    ["win32", "C:\\Program Files\\ClaudeCode\\managed-mcp.json"],
    ["linux", "/etc/claude-code/managed-mcp.json"],
  ] as const)("is looked up for %s", (platform, path) => {
    expect(managedMcpConfigPath(platform)).toBe(path);
    expect(hasManagedMcpConfig(platform, (candidate) => candidate === path)).toBe(true);
    expect(hasManagedMcpConfig(platform, () => false)).toBe(false);
  });

  it("counts an unreadable location as absent", () => {
    expect(hasManagedMcpConfig("linux", () => { throw new Error("EACCES"); })).toBe(false);
  });
});
