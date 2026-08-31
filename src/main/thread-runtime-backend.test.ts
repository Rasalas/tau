import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiComposerCommand } from "../shared/contracts.js";
import { ClaudeRuntimeSessionStore } from "./claude-runtime-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-runtime-backend.js";
import { createClaudeCodeRuntimeAdapter } from "./runtime-adapters.js";

const directories: string[] = [];
const commands: UiComposerCommand[] = [{ name: "skill:tdd", source: "skill", description: "Test first" }];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("thread runtime backends", () => {
  it("owns Claude transcript, skill preparation, and restart restoration without a Pi carrier", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-thread-backend-"));
    directories.push(directory);
    const store = new ClaudeRuntimeSessionStore({ filePath: join(directory, "sessions.json") });
    const sendPrompt = vi.fn(async () => ({ assistantText: "Claude answer" }));
    const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", store });
    adapter.transport.sendPrompt = sendPrompt;
    const first = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", {
      adapter,
      store,
      commands,
      projectName: "repo",
      permissionPolicy: () => ({ permissionMode: "auto", tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash"] }),
    });

    await first.create();
    const prepared = await first.preparePrompt("$tdd\n    preserve this", "tdd");
    expect(prepared).toMatchObject({
      backendKind: "claude-code",
      visibleText: "\n    preserve this",
      runtimeText: "/tdd \n    preserve this",
      skill: { name: "tdd", command: "/tdd" },
    });
    await first.prompt({ text: "$tdd\n    preserve this", clientMessageId: "request-1", delivery: "prompt", prepared });
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({ text: "/tdd \n    preserve this", sessionId: "tau-thread" }));
    expect(await first.transcript()).toMatchObject([
      { role: "user", text: "\n    preserve this", clientMessageId: "request-1", skill: { name: "tdd", command: "/tdd" } },
      { role: "assistant", text: "Claude answer" },
    ]);
    expect((await first.detail()).catalog.models).toEqual([]);

    const restored = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", {
      adapter,
      store: new ClaudeRuntimeSessionStore({ filePath: join(directory, "sessions.json") }),
      commands,
      projectName: "repo",
    });
    await restored.resume();
    expect(await restored.transcript()).toMatchObject([
      { role: "user", text: "\n    preserve this", clientMessageId: "request-1" },
      { role: "assistant", text: "Claude answer" },
    ]);
    expect((await restored.index()).backendKind).toBe("claude-code");
  });

  it("rejects manual approvals during prompt preparation before transport use", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-thread-policy-"));
    directories.push(directory);
    const store = new ClaudeRuntimeSessionStore({ filePath: join(directory, "sessions.json") });
    const sendPrompt = vi.fn(async () => ({ assistantText: "must not run" }));
    const adapter = createClaudeCodeRuntimeAdapter({ command: "unused", store });
    adapter.transport.sendPrompt = sendPrompt;
    const backend = new ClaudeThreadRuntimeBackend("tau-thread", "/repo", {
      adapter,
      store,
      commands,
      projectName: "repo",
      permissionPolicy: () => ({ permissionMode: "manual", tools: ["default"] }),
    });
    await backend.create();
    await expect(backend.preparePrompt("$tdd inspect", "tdd")).rejects.toThrow("manual approvals are unsupported");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
