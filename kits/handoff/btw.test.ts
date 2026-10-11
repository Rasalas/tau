import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionServices, HostThread, HostThreadLifecycle } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import { createHandoffHostExtension } from "./host.js";
import { BTW_EVENT, HANDOFF_EXTENSION_ID, type BtwChat, type BtwGone } from "./protocol.js";

const SOL = { provider: "openai-codex", id: "gpt-5.6-sol" };
const LUNA = { provider: "openai-codex", id: "gpt-5.6-luna" };
type Request = { system: string; prompt: string; signal?: AbortSignal; onText?: (delta: string) => void };

const entry = (id: string, message: Record<string, unknown>) => ({ type: "message", id, message });
const text = (value: string) => [{ type: "text", text: value }];
const journal = [
  entry("e1", { role: "user", content: text("Why is the build slow?") }),
  entry("e2", { role: "assistant", content: [...text("Let me look."), { type: "toolCall", name: "bash", arguments: { command: "npm run build" } }] }),
  entry("e3", { role: "toolResult", toolName: "bash", content: text("built in 41 s") }),
];

function makeThread(overrides: Record<string, unknown> = {}) {
  const complete = vi.fn(async (_provider: string, _id: string, request: Request) => { request.onText?.("It is "); request.onText?.("the bundler."); return "It is the bundler."; });
  const thread = {
    sessionId: "t1", cwd: "/project", backendKind: "pi", model: SOL,
    isStreaming: () => false, entries: () => journal, transcript: async () => [], complete,
    appendEntry: vi.fn(), ...overrides,
  } as unknown as HostThread;
  return { thread, complete };
}

describe("Handoff Kit side questions (/btw)", () => {
  let stateDir: string;
  let events: PublishedKitEvent[];
  let threads: Map<string, HostThread>;
  let lifecycle: HostThreadLifecycle | undefined;
  let servicesComplete: ReturnType<typeof vi.fn>;
  const registries: Array<Awaited<ReturnType<typeof activateHostKit>>> = [];

  beforeEach(async () => {
    stateDir = await mkdtemp(join(tmpdir(), "tau-btw-"));
    events = [];
    threads = new Map();
    lifecycle = undefined;
    servicesComplete = vi.fn(async () => "From a small model.");
  });
  afterEach(async () => {
    for (const registry of registries.splice(0)) await registry.dispose();
    await rm(stateDir, { recursive: true, force: true });
  });

  const activate = async () => {
    let id = 0;
    const registry = await activateHostKit(createHandoffHostExtension({ now: () => 1_000, newId: () => `c${++id}`, pushEveryMs: 0 }), {
      stateDir,
      thread: (sessionId?: string) => (sessionId ? threads.get(sessionId) : undefined),
      complete: servicesComplete as HostExtensionServices["complete"],
      completionModels: async () => [{ ...SOL, name: "Sol" }, { ...LUNA, name: "Luna" }],
      registerThreadLifecycle: (hooks) => { lifecycle = hooks; return () => undefined; },
    }, (event) => events.push(event));
    registries.push(registry);
    return registry;
  };
  const invoke = (registry: Awaited<ReturnType<typeof activate>>, command: string, input?: unknown) => registry.invoke(HANDOFF_EXTENSION_ID, command, input);
  const chats = () => events.filter((event) => event.name === BTW_EVENT).map((event) => event.payload as BtwChat & BtwGone);
  const settled = (status: string) => vi.waitFor(() => expect(chats().at(-1)?.status).toBe(status));

  it("answers from the thread's conversation, streamed, without writing to the thread", async () => {
    const { thread, complete } = makeThread();
    threads.set("t1", thread);
    const registry = await activate();
    const asked = await invoke(registry, "btw-ask", { threadId: "t1", question: "  What is slow? " }) as BtwChat;
    expect(asked).toMatchObject({ id: "c1", threadId: "t1", question: "What is slow?", status: "working", backend: "pi", entryId: "e3", answer: "" });
    await settled("done");

    const [provider, id, request] = complete.mock.calls[0]!;
    expect([provider, id]).toEqual(["openai-codex", "gpt-5.6-sol"]);
    expect(request.prompt).toContain("User: Why is the build slow?");
    expect(request.prompt).toContain("[called bash: npm run build]");
    expect(request.prompt).toContain("[bash returned: built in 41 s]");
    expect(request.prompt).toContain("Question: What is slow?");
    expect(request.prompt).not.toContain("still working");
    expect(chats().map((chat) => chat.answer)).toContain("It is the bundler.");
    expect(chats().at(-1)).toMatchObject({ status: "done", answer: "It is the bundler.", model: "openai-codex/gpt-5.6-sol" });
    expect(thread.appendEntry).not.toHaveBeenCalled();
    expect(await invoke(registry, "btw-get", { chatId: "c1" })).toMatchObject({ status: "done" });
  });

  it("asks while the agent is mid-turn, and reads a runtime without a journal from its transcript", async () => {
    const { thread, complete } = makeThread({
      isStreaming: () => true,
      entries: () => [],
      transcript: async () => [{ id: "m1", role: "user", text: "Fix the tests", timestamp: 1 }, { id: "m2", role: "assistant", text: "On it.", timestamp: 2 }],
    });
    threads.set("t1", thread);
    const registry = await activate();
    const asked = await invoke(registry, "btw-ask", { threadId: "t1", question: "Status?" }) as BtwChat;
    expect(asked.entryId).toBeUndefined();
    await settled("done");
    expect(complete.mock.calls[0]![2].prompt).toContain("still working");
    expect(complete.mock.calls[0]![2].prompt).toContain("User: Fix the tests\n\nAssistant: On it.");
  });

  it("uses a small model of the user's when the thread's runtime cannot complete", async () => {
    const unsupported = Object.assign(new Error("Model completions are not available for this thread's runtime (x)."), { name: "UnsupportedOperationError" });
    const { thread } = makeThread({ complete: vi.fn(async () => { throw unsupported; }), model: SOL });
    threads.set("t1", thread);
    const registry = await activate();
    await invoke(registry, "btw-ask", { threadId: "t1", question: "Why?" });
    await settled("done");
    expect(servicesComplete).toHaveBeenCalledTimes(1);
    expect(servicesComplete.mock.calls[0]![1]).toEqual(LUNA);
    expect(chats().at(-1)).toMatchObject({ answer: "From a small model.", model: "openai-codex/gpt-5.6-luna" });
  });

  it("keeps a failed question for a retry on the same tab", async () => {
    const complete = vi.fn(async () => { throw new Error("Rate limited."); });
    const { thread } = makeThread({ complete });
    threads.set("t1", thread);
    const registry = await activate();
    await invoke(registry, "btw-ask", { threadId: "t1", question: "Why?" });
    await settled("failed");
    expect(chats().at(-1)).toMatchObject({ id: "c1", error: "Rate limited.", answer: "" });

    complete.mockImplementationOnce(async (_p: string, _i: string, request: Request) => { request.onText?.("Fine."); return "Fine."; });
    await invoke(registry, "btw-ask", { threadId: "t1", question: "Why?", chatId: "c1" });
    await vi.waitFor(() => expect(chats().at(-1)).toMatchObject({ id: "c1", status: "done", answer: "Fine." }));
    expect(chats().at(-1)?.error).toBeUndefined();
  });

  it("stops the request and forgets the question when its tab closes", async () => {
    let seen: AbortSignal | undefined;
    const { thread } = makeThread({ complete: vi.fn((_p: string, _i: string, request: Request) => { seen = request.signal; return new Promise<string>(() => undefined); }) });
    threads.set("t1", thread);
    const registry = await activate();
    await invoke(registry, "btw-ask", { threadId: "t1", question: "Slow?" });
    await vi.waitFor(() => expect(seen).toBeDefined());
    await invoke(registry, "btw-forget", { chatId: "c1" });
    expect(seen?.aborted).toBe(true);
    expect(chats().at(-1)).toEqual({ id: "c1", gone: true });
    expect(await invoke(registry, "btw-get", { chatId: "c1" })).toBeUndefined();
  });

  it("refuses an empty question, a thread that is not open, and a fifth answer at once", async () => {
    const { thread } = makeThread({ complete: vi.fn(() => new Promise<string>(() => undefined)) });
    threads.set("t1", thread);
    const registry = await activate();
    await expect(invoke(registry, "btw-ask", { threadId: "t1", question: "  " })).rejects.toThrow("Add a question after /btw.");
    await expect(invoke(registry, "btw-ask", { threadId: "nope", question: "Hi" })).rejects.toThrow("not open");
    for (let index = 0; index < 4; index += 1) await invoke(registry, "btw-ask", { threadId: "t1", question: `Q${index}` });
    await expect(invoke(registry, "btw-ask", { threadId: "t1", question: "One more" })).rejects.toThrow("Wait for an earlier side question");
  });

  it("keeps answers across a restart, marks an unfinished one failed, and drops them with their thread", async () => {
    const { thread } = makeThread();
    threads.set("t1", thread);
    const first = await activate();
    await invoke(first, "btw-ask", { threadId: "t1", question: "Why?" });
    await settled("done");
    const pending = makeThread({ complete: vi.fn(() => new Promise<string>(() => undefined)) });
    threads.set("t2", pending.thread);
    await invoke(first, "btw-ask", { threadId: "t2", question: "Never answered" });
    await first.dispose();
    registries.splice(0);

    const second = await activate();
    expect(await invoke(second, "btw-get", { chatId: "c1" })).toMatchObject({ status: "done", answer: "It is the bundler." });
    expect(await invoke(second, "btw-get", { chatId: "c2" })).toMatchObject({ status: "failed", error: "Tau closed before this was answered." });
    await lifecycle!.threadDeleted!("t1", "/project");
    expect(await invoke(second, "btw-get", { chatId: "c1" })).toBeUndefined();
    expect(await invoke(second, "btw-get", { chatId: "c2" })).toBeDefined();
  });
});
