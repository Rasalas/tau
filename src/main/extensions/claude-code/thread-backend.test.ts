import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiComposerCommand } from "../../../shared/contracts.js";
import { ClaudeRuntimeSessionStore } from "./session-store.js";
import { ClaudeThreadRuntimeBackend } from "./thread-backend.js";
import { createClaudeCodeRuntimeAdapter } from "./runtime-adapter.js";

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
      permissionLevel: () => "full",
    });

    await first.create();
    const prepared = await first.preparePrompt("$tdd\n    preserve this", { source: "skill", name: "tdd", command: "/tdd", visibleText: "\n    preserve this" });
    expect(prepared).toMatchObject({
      backendKind: "claude-code",
      visibleText: "\n    preserve this",
      runtimeText: "/tdd \n    preserve this",
      skill: { name: "tdd", command: "/tdd" },
    });
    await first.prompt({ text: "$tdd\n    preserve this", clientMessageId: "request-1", delivery: "prompt", prepared });
    expect(sendPrompt).toHaveBeenCalledWith(expect.objectContaining({
      text: "/tdd \n    preserve this",
      sessionId: expect.any(String),
    }));
    const transportInput = ((sendPrompt.mock.calls as unknown[][])[0]?.[0] as { sessionId: string } | undefined);
    expect(transportInput?.sessionId).not.toBe("tau-thread");
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
      permissionLevel: () => "ask",
    });
    await backend.create();
    await expect(backend.preparePrompt("$tdd inspect", { source: "skill", name: "tdd", command: "/tdd", visibleText: "inspect" })).rejects.toThrow("manual approvals are unsupported");
    expect(sendPrompt).not.toHaveBeenCalled();
  });
});
