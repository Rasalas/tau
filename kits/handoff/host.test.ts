import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostThread, HostThreadLifecycle, HostTurnObserver, UiMessage } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createHandoffHostExtension } from "./host.js";
import { HANDOFF_EXTENSION_ID, LINEAGE_EVENT, type CreateTransferResult, type LineageState, type PrepareMergeBackResult, type ResolveTransferResult } from "./protocol.js";

const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
const SOL = { provider: "openai-codex", id: "gpt-5.6-sol" };

function thread(sessionId: string, messages: UiMessage[], overrides: Partial<HostThread> = {}): HostThread {
  return {
    sessionId,
    cwd: "/project",
    backendKind: "pi",
    sessionFile: undefined,
    model: SOL,
    isStreaming: () => false,
    sessionName: () => `Thread ${sessionId}`,
    transcript: async () => messages,
    ...overrides,
  } as unknown as HostThread;
}

const message = (id: string, role: "user" | "assistant", text: string): UiMessage => ({ id, role, text, timestamp: 1 });

describe("Handoff Kit host half", () => {
  let stateDir: string;
  let events: PublishedKitEvent[];
  let threads: Map<string, HostThread>;
  let complete: ReturnType<typeof vi.fn>;
  let lifecycle: HostThreadLifecycle | undefined;
  let observer: HostTurnObserver | undefined;
  const registries: Array<Awaited<ReturnType<typeof activateHostKit>>> = [];

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "tau-handoff-"));
    events = [];
    threads = new Map();
    complete = vi.fn(async () => "## Goal\nKeep the parser fast.");
    lifecycle = undefined;
    observer = undefined;
  });
  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.dispose();
    await rm(stateDir, { recursive: true, force: true });
  });

  const activate = async (services: Partial<HostExtensionServices> = {}) => {
    let id = 0;
    const registry = await activateHostKit(createHandoffHostExtension({ now: () => 1_000, newId: () => `t${++id}` }), {
      stateDir,
      thread: (sessionId?: string) => (sessionId ? threads.get(sessionId) : undefined),
      complete: complete as HostExtensionServices["complete"],
      completionModels: async () => [{ ...SOL, name: "Sol" }, { ...LUNA, name: "Luna" }],
      registerThreadLifecycle: (hooks) => { lifecycle = hooks; return () => undefined; },
      registerTurnObserver: (hooks) => { observer = hooks; return () => undefined; },
      ...services,
    }, (event) => events.push(event));
    registries.push(registry);
    return registry;
  };
  const invoke = (registry: Awaited<ReturnType<typeof activate>>, command: string, input?: unknown) => registry.invoke(HANDOFF_EXTENSION_ID, command, input);

  it("continues a thread on another runtime lazily: nothing is summarized until the first prompt", async () => {
    threads.set("parent", thread("parent", [message("u1", "user", "Speed up the parser."), message("a1", "assistant", "Cached the tokens in parser.ts.")]));
    const registry = await activate();

    const created = await invoke(registry, "create-transfer", { threadId: "parent", target: "codex" }) as CreateTransferResult;
    expect(created).toEqual({ transferId: "t1", native: false, sourceTitle: "Thread parent" });
    expect(complete).not.toHaveBeenCalled();

    const resolved = await invoke(registry, "resolve-transfer", { transferId: "t1" }) as ResolveTransferResult;
    expect(resolved.context).toBe([
      "<handoff_context>",
      "Continued from “Thread parent” (pi · openai-codex/gpt-5.6-sol). What happened there, as background for the message below:",
      "",
      "## Goal\nKeep the parser fast.",
      "</handoff_context>",
    ].join("\n"));
    // A small model close to the thread's, never the thread's own large one.
    expect(complete).toHaveBeenCalledTimes(1);
    expect(complete.mock.calls[0]![1]).toEqual(LUNA);
    expect(complete.mock.calls[0]![0].prompt).toContain("User: Speed up the parser.\n\nAssistant: Cached the tokens in parser.ts.");

    // A refused send asks again and gets the same handoff without a second summary.
    await invoke(registry, "resolve-transfer", { transferId: "t1" });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("summarizes the thread as it was when it was continued, even after it moved on", async () => {
    const messages = [message("u1", "user", "First goal."), message("a1", "assistant", "Done.")];
    threads.set("parent", thread("parent", messages));
    const registry = await activate();
    await invoke(registry, "create-transfer", { threadId: "parent", target: "codex" });
    messages.push(message("u2", "user", "Something later."));
    threads.delete("parent");
    await invoke(registry, "resolve-transfer", { transferId: "t1" });
    expect(complete.mock.calls[0]![0].prompt).not.toContain("Something later.");
  });

  it("links the fork once its thread exists and publishes the lineage", async () => {
    threads.set("parent", thread("parent", [message("u1", "user", "Go."), message("a1", "assistant", "Went.")]));
    threads.set("fork", thread("fork", [], { backendKind: "codex" }));
    const registry = await activate();
    await invoke(registry, "create-transfer", { threadId: "parent", target: "codex" });
    const lineage = await invoke(registry, "bind-transfer", { transferId: "t1", threadId: "fork" }) as LineageState;
    expect(lineage.links).toEqual([{ threadId: "fork", parentThreadId: "parent", strategy: "portable", sourceBackend: "pi", targetBackend: "codex", createdAt: 1_000 }]);
    expect(events.at(-1)).toMatchObject({ name: LINEAGE_EVENT, payload: lineage });
    await expect(invoke(registry, "resolve-transfer", { transferId: "t1" })).rejects.toThrow("That handoff is gone");

    // The link survives a restart.
    await registry.dispose();
    const again = await activate();
    expect(await invoke(again, "state")).toEqual(lineage);
    const saved = JSON.parse(await readFile(join(stateDir, HANDOFF_EXTENSION_ID, "lineage.json"), "utf8")) as { threads: Record<string, unknown> };
    expect(Object.keys(saved.threads)).toEqual(["fork"]);
  });

  it("forks natively on the same runtime and names the fork when the runtime writes it", async () => {
    threads.set("parent", thread("parent", [message("u1", "user", "Go."), message("a1", "assistant", "Went.")]));
    const registry = await activate();
    const created = await invoke(registry, "create-transfer", { threadId: "parent", target: "pi" }) as CreateTransferResult;
    expect(created.native).toBe(true);
    await lifecycle!.afterFork!(threads.get("parent")!, { sessionId: "clone" } as never);
    expect(complete).not.toHaveBeenCalled();
    expect((await invoke(registry, "state") as LineageState).links).toEqual([
      expect.objectContaining({ threadId: "clone", parentThreadId: "parent", strategy: "native" }),
    ]);
    // An ordinary fork later is not claimed by a continuation that was used up.
    await lifecycle!.afterFork!(threads.get("parent")!, { sessionId: "other" } as never);
    expect((await invoke(registry, "state") as LineageState).links).toHaveLength(1);
  });

  it("refuses a thread that is running or has nothing to hand over", async () => {
    threads.set("busy", thread("busy", [message("a1", "assistant", "…")], { isStreaming: () => true }));
    threads.set("empty", thread("empty", [message("u1", "user", "Hi")]));
    const registry = await activate();
    await expect(invoke(registry, "create-transfer", { threadId: "busy", target: "codex" })).rejects.toThrow("Wait for the thread's turn");
    await expect(invoke(registry, "create-transfer", { threadId: "empty", target: "codex" })).rejects.toThrow("nothing to hand over");
  });

  it("brings a fork back as a delta: what it did since the handoff, with the files it changed", async () => {
    const handoff = "<handoff_context>\nContinued from “Thread parent”.\n\nParent's context.\n</handoff_context>";
    const forkMessages = [message("f1", "user", `${handoff}\n\nAdd tests.`), message("f2", "assistant", "Added parser.test.ts.")];
    threads.set("parent", thread("parent", [message("u1", "user", "Go."), message("a1", "assistant", "Went.")]));
    threads.set("fork", thread("fork", forkMessages, { backendKind: "codex", model: { provider: "openai", id: "gpt-5.5-mini" } }));
    complete.mockImplementation(async () => "## What was done\nAdded tests.");
    const registry = await activate();
    await invoke(registry, "create-transfer", { threadId: "parent", target: "codex" });
    await invoke(registry, "bind-transfer", { transferId: "t1", threadId: "fork" });
    observer!.toolEnded!("fork", { id: "x", name: "write", args: { path: "src/parser.test.ts" }, status: "done", startedAt: 1 }, "/project");
    observer!.toolEnded!("unrelated", { id: "y", name: "write", args: { path: "src/other.ts" }, status: "done", startedAt: 1 }, "/project");
    complete.mockClear();

    const prepared = await invoke(registry, "prepare-merge-back", { threadId: "fork" }) as PrepareMergeBackResult;
    expect(prepared.parentThreadId).toBe("parent");
    expect(prepared.through).toBe("f2");
    expect(prepared.context).toContain("<merge_back_context>\nBrought back from the fork “Thread fork” (codex · openai/gpt-5.5-mini), 2 messages since it started:");
    expect(prepared.context).toContain("## What was done\nAdded tests.");
    const request = complete.mock.calls[0]![0] as { prompt: string };
    expect(request.prompt).toContain("Files the fork changed: src/parser.test.ts");
    expect(request.prompt).toContain("User: Add tests.");
    expect(request.prompt).not.toContain("Parent's context.");
    expect(complete.mock.calls[0]![1]).toEqual({ provider: "openai-codex", id: "gpt-5.6-luna" });

    await invoke(registry, "commit-merge-back", { threadId: "fork", through: prepared.through });
    await expect(invoke(registry, "prepare-merge-back", { threadId: "fork" })).rejects.toThrow("Nothing new since it was last brought back.");
    forkMessages.push(message("f3", "user", "Also docs."), message("f4", "assistant", "Wrote README."));
    const next = await invoke(registry, "prepare-merge-back", { threadId: "fork" }) as PrepareMergeBackResult;
    expect(next.context).toContain("2 messages since it was last brought back");
    expect((complete.mock.calls.at(-1)![0] as { prompt: string }).prompt).not.toContain("Add tests.");
  });

  it("brings a sub-agent back to the thread that spawned it", async () => {
    threads.set("child", thread("child", [message("c1", "user", "Look into flaky tests."), message("c2", "assistant", "The clock mock leaks.")], { parentThreadId: "parent" }));
    const registry = await activate();
    const prepared = await invoke(registry, "prepare-merge-back", { threadId: "child" }) as PrepareMergeBackResult;
    expect(prepared.parentThreadId).toBe("parent");
    expect(prepared.context).toContain("Brought back from the sub-agent “Thread child”");
  });

  it("refuses to bring back a thread without a parent", async () => {
    threads.set("alone", thread("alone", [message("u1", "user", "Hi"), message("a1", "assistant", "Hello")]));
    const registry = await activate();
    await expect(invoke(registry, "prepare-merge-back", { threadId: "alone" })).rejects.toThrow("not continued or spawned from another thread");
  });

  it("writes the latest turns instead of calling the user's default model when no small model is reachable", async () => {
    threads.set("parent", thread("parent", [message("u1", "user", "Go."), message("a1", "assistant", "Went.")]));
    const registry = await activate({ completionModels: async () => [{ ...SOL, name: "Sol" }] });
    await invoke(registry, "create-transfer", { threadId: "parent", target: "codex" });
    const resolved = await invoke(registry, "resolve-transfer", { transferId: "t1" }) as ResolveTransferResult;
    expect(complete).not.toHaveBeenCalled();
    expect(resolved.context).toContain("_No summary was written (no small model is configured); these are the latest turns._");
    expect(resolved.context).toContain("User: Go.");
  });
});
