import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadRuntimeEvent } from "tau/host-extension";
import type { AcpContentBlock, AcpPermissionRequest, AcpPermissionResponse, AcpSelectOption, AcpSessionSetup } from "./acp-session.js";
import type { AcpPromptResponse, AcpSessionUpdate } from "./events.js";
import { createAntigravityRuntimeAdapter } from "./runtime-adapter.js";
import { AntigravitySessionStore } from "./session-store.js";
import { AntigravityThreadRuntimeBackend, promptBlocks, type AntigravitySessionInput, type AntigravitySessionLike } from "./thread-backend.js";
import { until } from "./acp-fake.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function scratchStore(): Promise<AntigravitySessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "tau-agy-backend-"));
  directories.push(directory);
  return new AntigravitySessionStore({ filePath: join(directory, "sessions.json") });
}

type Script = (blocks: readonly AcpContentBlock[], session: FakeSession) => Promise<AcpPromptResponse> | AcpPromptResponse;

/** A scripted ACP session: `script` answers each prompt and may stream updates through `session.update`. */
class FakeSession implements AntigravitySessionLike {
  closed = false;
  sessionId: string | undefined;
  modeId: string | undefined = "default";
  readonly stderr = "";
  readonly initialized = { protocolVersion: 1, agentCapabilities: { promptCapabilities: { image: true }, sessionCapabilities: { resume: {} } } };
  readonly calls: string[] = [];
  private cancelRequested?: () => void;
  constructor(readonly input: AntigravitySessionInput, private readonly script: Script, private readonly resumeFails = false) {}
  async newSession(): Promise<AcpSessionSetup> { this.calls.push("new"); this.sessionId = "acp-1"; return { sessionId: "acp-1" }; }
  async resumeSession(sessionId: string): Promise<AcpSessionSetup> {
    this.calls.push(`resume:${sessionId}`);
    if (this.resumeFails) throw new Error("session not found");
    this.sessionId = sessionId;
    return { sessionId };
  }
  modelOptions(): AcpSelectOption[] { return [{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }]; }
  modeOptions(): AcpSelectOption[] { return [{ value: "default", name: "Default" }, { value: "yolo", name: "Turbo" }]; }
  private model = "gemini-3.8-flash-high";
  currentModel(): string | undefined { return this.model; }
  async setModel(modelId: string): Promise<void> { this.calls.push(`model:${modelId}`); this.model = modelId; }
  async setMode(modeId: string): Promise<void> { this.calls.push(`mode:${modeId}`); this.modeId = modeId; }
  update(update: AcpSessionUpdate): void { this.input.onUpdate(update); }
  async prompt(blocks: readonly AcpContentBlock[]): Promise<AcpPromptResponse> {
    this.calls.push(`prompt:${blocks.map((block) => block.type === "text" ? block.text : block.type).join("|")}`);
    return this.script(blocks, this);
  }
  /** Resolves when the script waits for a cancel. */
  waitForCancel(): Promise<void> { return new Promise((resolve) => { this.cancelRequested = resolve; }); }
  async cancel(): Promise<void> { this.calls.push("cancel"); this.cancelRequested?.(); }
  async close(): Promise<void> { this.closed = true; this.input.onExit(undefined); }
}

function harness(store: AntigravitySessionStore, script: Script, options: { ask?: AntigravityThreadRuntimeBackend extends never ? never : (prompt: unknown) => Promise<{ value?: string; confirmed?: boolean; cancelled?: true }>; level?: "read-only" | "ask" | "full"; resumeFails?: boolean; cachedModels?: AcpSelectOption[] } = {}) {
  const events: ThreadRuntimeEvent[] = [];
  const sessions: FakeSession[] = [];
  const reportedModels: AcpSelectOption[][] = [];
  const backend = new AntigravityThreadRuntimeBackend("thread", "/repo", {
    adapter: createAntigravityRuntimeAdapter(),
    store,
    openSession: async (input) => { const session = new FakeSession(input, script, options.resumeFails); sessions.push(session); return session; },
    onEvent: (event) => events.push(event),
    ...(options.cachedModels ? { cachedModels: async () => options.cachedModels! } : {}),
    onModels: (models) => reportedModels.push([...models]),
    ask: options.ask as never,
    projectName: "repo",
    permissionLevel: () => options.level ?? "full",
    now: (() => { let clock = 1_000; return () => clock++; })(),
  });
  return { backend, events, sessions, reportedModels };
}

const reply = (text: string): Script => async (_blocks, session) => {
  session.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  return { stopReason: "end_turn", usage: { inputTokens: 5, outputTokens: 2 } };
};

describe("AntigravityThreadRuntimeBackend", () => {
  it("creates a session on the first turn, streams the answer as events, keeps usage, and resumes the session next time", async () => {
    const store = await scratchStore();
    const { backend, events, sessions } = harness(store, reply("hello there"));
    await backend.start("create");
    const result = await backend.prompt({ text: "hi", delivery: "prompt", identity: { clientMessageId: "c1", clientTurnId: "t1" } });
    expect(result).toEqual({ assistantText: "hello there" });
    expect(events.map((event) => event.type)).toEqual(["user-message", "turn-started", "queue", "assistant-start", "assistant-delta", "assistant-end", "usage", "turn-settled", "queue"]);
    expect(sessions[0]!.calls).toEqual(["new", "mode:yolo", "prompt:hi"]);
    expect(backend.catalogView()).toMatchObject({ model: { provider: "google", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }, usage: { inputTokens: 5, outputTokens: 2, turns: 1 } });
    expect((await backend.transcript()).map((message) => message.text)).toEqual(["hi", "hello there"]);
    expect(backend.state()).toMatchObject({ idle: true, title: "hi" });
    await backend.dispose();

    const again = harness(store, reply("again"), { cachedModels: [{ value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }] });
    await again.backend.start("resume");
    expect((await again.backend.transcript()).map((message) => message.text)).toEqual(["hi", "hello there"]);
    // No session yet, and the user never picked a model: the thread still names the one it ran on.
    expect(again.backend.catalogView().model).toEqual({ provider: "google", id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" });
    await again.backend.prompt({ text: "more", delivery: "prompt" });
    expect(again.sessions[0]!.calls).toEqual(["resume:acp-1", "mode:yolo", "prompt:more"]);
    expect(again.backend.catalogView().usage?.turns).toBe(2);
  });

  it("starts afresh when the agent no longer knows the stored session, and applies the chosen model", async () => {
    const store = await scratchStore();
    await store.ensure("thread", "/repo");
    await store.setAcpSession("thread", "/repo", "gone");
    const { backend, sessions, events } = harness(store, reply("ok"), { resumeFails: true });
    await backend.start("resume");
    await backend.capabilities.catalogWrite!.setModel("google", "gemini-3.8-flash-low");
    await backend.prompt({ text: "go", delivery: "prompt" });
    expect(sessions[0]!.calls).toEqual(["resume:gone", "new", "model:gemini-3.8-flash-low", "mode:yolo", "prompt:go"]);
    expect(events.find((event) => event.type === "notice")).toMatchObject({ level: "warning" });
    expect((await store.get("thread"))?.acpSessionId).toBe("acp-1");
    expect((await store.get("thread"))?.model).toBe("gemini-3.8-flash-low");
    expect((await backend.models()).map((model) => model.id)).toEqual(["gemini-3.8-flash-low", "gemini-3.8-flash-high"]);
  });

  it("routes the agent's permission request to the dialog surface and answers with the chosen option", async () => {
    const store = await scratchStore();
    const asked: unknown[] = [];
    const ask = vi.fn(async (prompt: unknown) => { asked.push(prompt); return { value: "Allow" }; });
    const script: Script = async (_blocks, session) => {
      const request: AcpPermissionRequest = { sessionId: "acp-1", options: [{ optionId: "yes", name: "Allow", kind: "allow_once" }, { optionId: "no", name: "Reject", kind: "reject_once" }], toolCall: { toolCallId: "call", title: "Write a.txt", kind: "edit" } };
      const answer: AcpPermissionResponse = await session.input.onPermission(request);
      session.update({ sessionUpdate: "tool_call", toolCallId: "call", title: "Write a.txt", kind: "edit", status: "completed" });
      session.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: JSON.stringify(answer) } });
      return { stopReason: "end_turn" };
    };
    const { backend, sessions, events } = harness(store, script, { ask, level: "ask" });
    await backend.start("create");
    const result = await backend.prompt({ text: "edit", delivery: "prompt" });
    expect(asked[0]).toMatchObject({ kind: "select", title: "Write a.txt", options: ["Allow", "Deny"] });
    expect(result.assistantText).toBe(JSON.stringify({ outcome: { outcome: "selected", optionId: "yes" } }));
    expect(sessions[0]!.calls[1]).toBe("mode:default");
    expect(events.filter((event) => event.type === "tool-start" || event.type === "tool-end").length).toBe(2);
  });

  it("queues a follow-up behind the running turn, and a steer cancels the running turn and takes its place", async () => {
    const store = await scratchStore();
    let release!: () => void;
    const first = new Promise<void>((resolve) => { release = resolve; });
    let turns = 0;
    const script: Script = async (blocks, session) => {
      turns += 1;
      if (turns === 1) {
        await Promise.race([first, session.waitForCancel().then(() => "cancelled" as const)]).then((value) => value);
        if (session.calls.includes("cancel")) return { stopReason: "cancelled" };
      }
      const text = blocks[0]!.type === "text" ? blocks[0]!.text : "";
      session.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: `echo ${text}` } });
      return { stopReason: "end_turn" };
    };
    const { backend, events } = harness(store, script);
    await backend.start("create");
    const one = backend.prompt({ text: "one", delivery: "prompt" });
    await until(() => turns === 1);
    const two = backend.prompt({ text: "two", delivery: "followUp" });
    await until(() => events.some((event) => event.type === "queue" && event.followUp.length === 1));
    expect(backend.state().streaming).toBe(true);
    const steer = backend.prompt({ text: "steer", delivery: "steer" });
    expect(await one).toEqual({ assistantText: "" });
    expect(await steer).toEqual({ assistantText: "echo steer" });
    expect(await two).toEqual({ assistantText: "echo two" });
    const settled = events.filter((event) => event.type === "turn-settled").map((event) => event.status);
    expect(settled).toEqual(["interrupted", "completed", "completed"]);
    release();
  });

  it("lists the models a past session reported before a new one exists, and reports them once it does", async () => {
    const store = await scratchStore();
    const cached = [{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }];
    const { backend, reportedModels } = harness(store, reply("ok"), { cachedModels: cached });
    await backend.start("create");
    // No session yet: the picker still has the account's models.
    expect((await backend.models()).map((model) => model.id)).toEqual(["gemini-3.8-flash-low"]);
    expect(reportedModels).toEqual([]);
    await backend.prompt({ text: "hi", delivery: "prompt" });
    expect(reportedModels).toEqual([[{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { value: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" }]]);
    expect((await backend.models()).map((model) => model.id)).toEqual(["gemini-3.8-flash-low", "gemini-3.8-flash-high"]);
  });

  it("puts text before images in the prompt and reports a stopped agent as an error notice", async () => {
    expect(promptBlocks("look", [{ mimeType: "image/png", data: "AAAA", name: "a.png" } as never])).toEqual([{ type: "text", text: "look" }, { type: "image", data: "AAAA", mimeType: "image/png" }]);
    const store = await scratchStore();
    const script: Script = async (_blocks, session) => { session.input.onExit(new Error("Antigravity exited with code 1.")); throw new Error("Antigravity exited with code 1."); };
    const { backend, events } = harness(store, script);
    await backend.start("create");
    // The exit settles the turn before the prompt call returns; the failure is on the transcript, not thrown twice.
    expect(await backend.prompt({ text: "boom", delivery: "prompt" })).toEqual({});
    expect(events.filter((event) => event.type === "notice").map((event) => event.level)).toEqual(["error"]);
    expect(events.filter((event) => event.type === "turn-settled").map((event) => event.status)).toEqual(["error"]);
    expect(backend.state().idle).toBe(true);
  });
});
