import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TurnActivityStore, type BackendPrompt, type ExtensionUiAnswer, type RuntimePermissionLevel, type ThreadRuntimeEvent } from "tau/host-extension";
import { ALLOW, DENY, rulesForLevel } from "./approvals.js";
import { storedModels } from "./catalog.js";
import type { OpenCodeProviderList } from "./client.js";
import { FAKE_PROVIDERS, replay, startFakeOpenCode, untilAborted, type FakeOpenCode, type FakeScript } from "./fixtures/fake-server.js";
import { createOpenCodeRuntimeAdapter } from "./runtime-adapter.js";
import { connectOpenCodeServer } from "./server.js";
import { OpenCodeSessionStore } from "./session-store.js";
import { OpenCodeThreadRuntimeBackend, promptParts, type OpenCodeConnectInput } from "./thread-backend.js";

const directories: string[] = [];
const fakes: FakeOpenCode[] = [];
const backends: OpenCodeThreadRuntimeBackend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratch(script?: FakeScript) {
  const dir = await mkdtemp(join(tmpdir(), "tau-opencode-backend-"));
  directories.push(dir);
  const fake = await startFakeOpenCode({ password: "secret", ...(script ? { script } : {}) });
  fakes.push(fake);
  return { dir, fake, store: new OpenCodeSessionStore({ filePath: join(dir, "opencode-runtime-sessions.json") }), connects: [] as OpenCodeConnectInput[] };
}

type Scratch = Awaited<ReturnType<typeof scratch>>;

async function open(space: Scratch, options: { level?: RuntimePermissionLevel; answer?: (prompt: BackendPrompt) => ExtensionUiAnswer; resume?: boolean; tools?: string[]; activity?: TurnActivityStore; threadId?: string } = {}) {
  const events: ThreadRuntimeEvent[] = [];
  const asked: BackendPrompt[] = [];
  const backend = new OpenCodeThreadRuntimeBackend(options.threadId ?? "tau-1", space.dir, {
    adapter: createOpenCodeRuntimeAdapter(),
    store: space.store,
    connect: async (input) => {
      space.connects.push(input);
      return connectOpenCodeServer(space.fake.url, "secret");
    },
    storedModels: async () => storedModels(FAKE_PROVIDERS as unknown as OpenCodeProviderList),
    onEvent: (event) => events.push(event),
    ask: async (prompt) => { asked.push(prompt); return options.answer ? options.answer(prompt) : { cancelled: true }; },
    permissionLevel: () => options.level ?? "full",
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.activity ? { activity: options.activity } : {}),
  });
  backends.push(backend);
  await backend.start(options.resume ? "resume" : "create");
  return { backend, events, asked };
}

const prompts = (fake: FakeOpenCode) => fake.requests.filter((request) => request.path.endsWith("/prompt_async"));

describe("OpenCodeThreadRuntimeBackend against a fake OpenCode server", () => {
  it("creates a session on the first turn, streams the answer and keeps both messages and OpenCode's usage", async () => {
    const space = await scratch();
    const { backend, events } = await open(space);
    const result = await backend.prompt({ text: "Reply with exactly one word: ok", delivery: "prompt", identity: { clientMessageId: "m1", clientTurnId: "t1" } });
    expect(result).toEqual({ assistantText: "ok" });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("user-message");
    expect(types).toContain("assistant-delta");
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "completed" });
    expect((await backend.transcript()).map((message) => [message.role, message.text])).toEqual([["user", "Reply with exactly one word: ok"], ["assistant", "ok"]]);
    // The session is named after the prompt, so OpenCode spends no model call on a title.
    const created = space.fake.requests.find((request) => request.method === "POST" && request.path === "/session")!;
    expect(created.body).toEqual({ title: "Reply with exactly one word: ok", permission: rulesForLevel("full") });
    expect(created.query.directory).toBe(space.dir);
    const view = backend.catalogView();
    expect(view.model).toMatchObject({ provider: "opencode", id: "mimo-v2.6-flash-free" });
    expect(view.usage).toMatchObject({ turns: 1, costUsd: 0, inputTokens: 10992 });
    const stored = await space.store.get("tau-1");
    expect(stored).toMatchObject({ sessionId: expect.stringMatching(/^ses_/u), observedModel: { provider: "opencode", id: "mimo-v2.6-flash-free" }, usage: { turns: 1 } });
    expect(stored!.messages.map((message) => message.text)).toEqual(["Reply with exactly one word: ok", "ok"]);
  });

  it("asks before a command at the ask level and answers OpenCode with the choice", async () => {
    const space = await scratch(replay("tool"));
    const { backend, events, asked } = await open(space, { level: "ask", answer: () => ({ value: ALLOW }) });
    await backend.prompt({ text: "Run echo hi", delivery: "prompt" });
    expect(asked).toEqual([expect.objectContaining({ kind: "select", title: "OpenCode wants to run a command", message: "echo hi\nFor this session: echo *" })]);
    expect(space.fake.requests.find((request) => request.path.startsWith("/permission/"))?.body).toEqual({ reply: "once" });
    const end = events.find((event) => event.type === "tool-end") as Extract<ThreadRuntimeEvent, { type: "tool-end" }>;
    expect(end.tool).toMatchObject({ name: "bash", args: { command: "echo hi" }, status: "done", output: "hi\n" });
    expect(space.fake.requests.find((request) => request.method === "POST" && request.path === "/session")?.body).toMatchObject({ permission: rulesForLevel("ask") });
  });

  it("answers a request itself at full access and rejects one the user denies", async () => {
    const full = await scratch(replay("tool"));
    const { backend, asked } = await open(full);
    await backend.prompt({ text: "Run echo hi", delivery: "prompt" });
    expect(asked).toEqual([]);
    expect(full.fake.requests.find((request) => request.path.startsWith("/permission/"))?.body).toEqual({ reply: "once" });

    const denied = await scratch(replay("tool"));
    const second = await open(denied, { level: "ask", answer: () => ({ value: DENY }) });
    await second.backend.prompt({ text: "Run echo hi", delivery: "prompt" });
    expect(denied.fake.requests.find((request) => request.path.startsWith("/permission/"))?.body).toEqual({ reply: "reject" });
  });

  it("asks a sub-agent's permission request too", async () => {
    const space = await scratch(async (turn) => {
      const child = { id: "ses_child", directory: turn.session.directory, parentID: turn.session.id };
      turn.emit({ type: "session.created", properties: { sessionID: child.id, info: child } });
      await turn.ask("permission", { id: "per_child", sessionID: child.id, permission: "edit", patterns: ["src/a.ts"], metadata: { filepath: "src/a.ts" }, always: [] });
      turn.emit({ type: "session.status", properties: { sessionID: turn.session.id, status: { type: "busy" } } });
      turn.emit({ type: "session.status", properties: { sessionID: turn.session.id, status: { type: "idle" } } });
    });
    const { backend, asked } = await open(space, { level: "ask", answer: () => ({ value: ALLOW }) });
    await backend.prompt({ text: "Edit it", delivery: "prompt" });
    expect(asked).toEqual([expect.objectContaining({ title: "OpenCode wants to edit files", message: "src/a.ts" })]);
  });

  it("puts OpenCode's questions on the dialog surface and replies with the labels", async () => {
    const replies: unknown[] = [];
    const space = await scratch(async (turn) => {
      replies.push(await turn.ask("question", { id: "que_1", sessionID: turn.session.id, questions: [{ question: "Which one?", header: "Pick", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] }));
      replies.push(await turn.ask("question", { id: "que_2", sessionID: turn.session.id, questions: [{ question: "Why?", header: "", options: [] }] }));
      turn.emit({ type: "session.status", properties: { sessionID: turn.session.id, status: { type: "busy" } } });
      turn.emit({ type: "session.idle", properties: { sessionID: turn.session.id } });
    });
    const { backend } = await open(space, { answer: (prompt) => prompt.kind === "select" ? { value: "B" } : { cancelled: true } });
    await backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(replies).toEqual([[["B"]], { rejected: true }]);
  });

  it("sends the picked model, reasoning effort and plan mode with the prompt", async () => {
    const space = await scratch();
    const { backend } = await open(space);
    await backend.capabilities.catalogWrite!.setModel("opencode", "gpt-5.6-luna");
    await backend.capabilities.catalogWrite!.setThinkingLevel("high");
    await backend.capabilities.mode!.set("plan");
    expect(backend.catalogView()).toMatchObject({ model: { provider: "opencode", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }, thinkingLevel: "high", thinkingLevels: ["default", "low", "medium", "high"] });
    await backend.prompt({ text: "Plan it", delivery: "prompt" });
    expect(prompts(space.fake)[0]!.body).toMatchObject({ model: { providerID: "opencode", modelID: "gpt-5.6-luna" }, variant: "high", agent: "plan", system: expect.stringContaining("<proposed_plan>") });
    await expect(backend.capabilities.catalogWrite!.setModel("opencode", "nope")).rejects.toThrow(/no model/u);
    await expect(backend.capabilities.catalogWrite!.setThinkingLevel("max")).rejects.toThrow(/no reasoning effort/u);
    await backend.capabilities.mode!.set("default");
    await backend.prompt({ text: "Now do it", delivery: "prompt" });
    expect(prompts(space.fake)[1]!.body).not.toHaveProperty("agent");
  });

  it("keeps a thread's tool list: OpenCode's other tools off, and read-only without a writing tool", async () => {
    const space = await scratch();
    const { backend } = await open(space, { tools: ["read", "grep"], level: "ask" });
    await backend.prompt({ text: "Look", delivery: "prompt" });
    expect(prompts(space.fake)[0]!.body).toMatchObject({ tools: { read: true, grep: true, bash: false, edit: false, write: false, task: false } });
    expect(space.fake.requests.find((request) => request.method === "POST" && request.path === "/session")?.body).toMatchObject({ permission: rulesForLevel("read-only") });
    expect(space.connects[0]).toMatchObject({ threadId: "tau-1", tools: ["read", "grep"] });
  });

  it("resumes the stored session after a restart, and starts a new one when OpenCode lost it", async () => {
    const space = await scratch();
    const first = await open(space);
    await first.backend.prompt({ text: "One", delivery: "prompt" });
    await first.backend.dispose();
    const sessionId = (await space.store.get("tau-1"))!.sessionId!;

    const resumed = await open(space, { resume: true, level: "ask" });
    expect((await resumed.backend.transcript()).map((message) => message.text)).toEqual(["One", "ok"]);
    await resumed.backend.prompt({ text: "Two", delivery: "prompt" });
    expect(space.fake.requests.filter((request) => request.method === "POST" && request.path === "/session")).toHaveLength(1);
    expect(space.fake.requests.find((request) => request.method === "PATCH")).toMatchObject({ path: `/session/${sessionId}`, body: { permission: rulesForLevel("ask") } });
    await resumed.backend.dispose();

    space.fake.sessions.clear();
    const lost = await open(space, { resume: true });
    await lost.backend.prompt({ text: "Three", delivery: "prompt" });
    expect(lost.events).toContainEqual({ type: "notice", message: "OpenCode no longer has this conversation; a new one starts here.", level: "warning" });
    expect((await space.store.get("tau-1"))!.sessionId).not.toBe(sessionId);
  });

  it("aborts a running turn through OpenCode and settles it as interrupted", async () => {
    const space = await scratch(untilAborted);
    const { backend, events } = await open(space);
    const running = backend.prompt({ text: "Sleep", delivery: "prompt" });
    await expect.poll(() => events.some((event) => event.type === "tool-start")).toBe(true);
    await backend.abort();
    await running;
    expect(space.fake.requests.some((request) => request.path.endsWith("/abort"))).toBe(true);
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "interrupted" });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { id: "call_sleep", status: "error", output: "Interrupted." } });
  });

  it("joins a steer to the running turn and queues a follow-up behind it", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const space = await scratch(async (turn) => {
      if (prompts(space.fake).length === 1) await held;
      await replay("reply")(turn);
    });
    const { backend, events } = await open(space);
    const first = backend.prompt({ text: "First", delivery: "prompt" });
    await expect.poll(() => prompts(space.fake).length).toBe(1);
    await backend.prompt({ text: "Also this", delivery: "steer" });
    expect(prompts(space.fake)).toHaveLength(2);
    const later = backend.prompt({ text: "Then this", delivery: "followUp" });
    await expect.poll(() => events.filter((event) => event.type === "queue").at(-1)).toEqual({ type: "queue", steering: [], followUp: ["Then this"] });
    release();
    await Promise.all([first, later]);
    expect(prompts(space.fake)).toHaveLength(3);
  });

  it("fails the running turn when its server exits", async () => {
    const space = await scratch(untilAborted);
    const { backend, events } = await open(space);
    const running = backend.prompt({ text: "Sleep", delivery: "prompt" });
    await expect.poll(() => events.some((event) => event.type === "tool-start")).toBe(true);
    space.connects[0]!.onExit(new Error("OpenCode's server exited with code 1."));
    await running;
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "error", error: "OpenCode's server exited with code 1." });
  });

  it("keeps the tool cards of its turns in the activity store", async () => {
    const space = await scratch();
    const activity = new TurnActivityStore({ directory: join(space.dir, "activity") });
    const { backend } = await open(space, { activity });
    await backend.capabilities.activityHistory!.save({ id: "activity-1", status: "completed", tools: [{ id: "a", name: "bash", args: {}, status: "done", startedAt: 1 }] });
    expect((await backend.capabilities.activityHistory!.load()).map((entry) => entry.id)).toEqual(["activity-1"]);
  });
});

describe("a prompt's parts", () => {
  it("names attached files by path and sends images as data URLs", () => {
    expect(promptParts("Look", [{ kind: "file", path: "/tmp/a.txt", name: "a.txt" }, { kind: "image", mimeType: "image/png", data: "AAAA", name: "shot.png" }] as never)).toEqual([
      { type: "text", text: "Look\n\nAttached files:\n- /tmp/a.txt" },
      { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
    ]);
  });
});
