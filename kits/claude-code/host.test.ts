import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostRuntimeBackendProvider } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createClaudeCodeHostExtension from "./host.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function harness(findCommand: (name: string) => string | undefined) {
  const agentDir = await mkdtemp(join(tmpdir(), "tau-claude-host-"));
  directories.push(agentDir);
  const backends: HostRuntimeBackendProvider[] = [];
  const registry = await activateHostKit(createClaudeCodeHostExtension({ agentDir }), {
    findCommand,
    agentDir: () => agentDir,
    skills: () => [{ name: "tdd", description: "Test first" }, { name: "not a skill name", description: "ignored" }],
    registerRuntimeBackend: (provider) => { backends.push(provider); return () => undefined; },
  });
  return { registry, backends, agentDir };
}

describe("Claude Code host half", () => {
  it("registers its backend through the seam and publishes the skills as Claude commands", async () => {
    const { backends } = await harness(() => "/usr/local/bin/claude");
    const [provider] = backends;
    expect(provider?.kind).toBe("claude-code");
    expect(provider?.adapter.id).toBe("claude-code");
    expect(provider?.modelProvider).toBe("anthropic");
    // Only names Claude can be asked to run; the dialect is the adapter's.
    expect(provider?.composerCommands("/repo")).toEqual([
      { name: "skill:tdd", description: "Test first", source: "skill", skillCommand: "/tdd" },
    ]);
    // Claude cannot stop for an approval in print mode, so `ask` is refused early.
    expect(() => provider?.assertPromptAllowed?.("ask")).toThrow("manual approvals are unsupported");
    expect(provider?.assertPromptAllowed?.("full")).toBeUndefined();
  });

  it("reports where the CLI is, and refuses to open a thread when it is missing", async () => {
    const found = await harness((name) => name === "claude" ? "/usr/local/bin/claude" : undefined);
    await expect(found.registry.invoke("tau.claude-code", "status"))
      .resolves.toEqual({ kind: "claude-code", command: "claude", path: "/usr/local/bin/claude" });

    const missing = await harness(() => undefined);
    await expect(missing.registry.invoke("tau.claude-code", "status"))
      .resolves.toEqual({ kind: "claude-code", command: "claude", path: undefined });
    await expect(missing.backends[0]!.open("thread", "/repo", { resume: false }, {
      projectName: "repo",
      permissionLevel: () => "full",
    } as never)).rejects.toThrow("was not found on the PATH");
  });
});
