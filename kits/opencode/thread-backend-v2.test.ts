import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendPrompt, ExtensionUiAnswer, RuntimePermissionLevel, ThreadRuntimeEvent } from "tau/host-extension";
import { ALLOW, ALLOW_SESSION, DENY, rulesForLevelV2 } from "./approvals.js";
import { storedModels } from "./catalog.js";
import { connectOpenCodeApi } from "./connect.js";
import { startFakeOpenCode } from "./fixtures/fake-server.js";
import { announcePrompt, replay2, startFakeOpenCode2, textTurn, untilInterrupted, type FakeOpenCode2, type FakeOpenCode2Options, type FakeScript2, type FakeTurn2 } from "./fixtures/fake-server-v2.js";
import { createOpenCodeRuntimeAdapter } from "./runtime-adapter.js";
import { connectOpenCodeServer, type OpenCodeServerHandle } from "./server.js";
import { OpenCodeSessionStore } from "./session-store.js";
import { OpenCodeThreadRuntimeBackend, type OpenCodeConnectInput } from "./thread-backend.js";

const directories: string[] = [];
const fakes: Array<{ close(): Promise<void> }> = [];
const backends: OpenCodeThreadRuntimeBackend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(fakes.splice(0).map((fake) => fake.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratch(options: FakeOpenCode2Options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "tau-opencode-backend-v2-"));
  directories.push(dir);
  const fake = await startFakeOpenCode2({ password: "secret", ...options });
  fakes.push(fake);
  return {
    dir,
    fake,
    store: new OpenCodeSessionStore({ filePath: join(dir, "opencode-runtime-sessions.json") }),
    connects: [] as OpenCodeConnectInput[],
    handles: [] as OpenCodeServerHandle[],
    models: undefined as ReturnType<typeof storedModels> | undefined,
  };
}

type Scratch = Awaited<ReturnType<typeof scratch>>;

interface OpenOptions {
  level?: RuntimePermissionLevel;
  answer?: (prompt: BackendPrompt) => ExtensionUiAnswer;
  /** `false`: the host cannot ask. */
  ask?: boolean;
  resume?: boolean;
  tools?: string[];
  threadId?: string;
  mcpServers?: string[];
  /** The handle says Tau started the server. */
  local?: boolean;
  sleep?: (ms: number) => Promise<void>;
  interruptMs?: number;
}

/** A handle on the fake the way `connectOpenCodeServer` builds one, with what a test adds. */
async function handleFor(space: Scratch, options: OpenOptions): Promise<OpenCodeServerHandle> {
  const api = await connectOpenCodeApi({ url: space.fake.url, password: "secret", api2: { sleep: options.sleep ?? (async () => undefined) } });
  let closed = false;
  const handle: OpenCodeServerHandle = {
    url: space.fake.url,
    password: "secret",
    local: options.local ?? false,
    ...(options.mcpServers ? { mcpServers: options.mcpServers } : {}),
    api,
    get closed() { return closed; },
    close: async () => { closed = true; },
  };
  space.handles.push(handle);
  return handle;
}

async function open(space: Scratch, options: OpenOptions = {}) {
  const events: ThreadRuntimeEvent[] = [];
  const asked: BackendPrompt[] = [];
  const backend = new OpenCodeThreadRuntimeBackend(options.threadId ?? "tau-1", space.dir, {
    adapter: createOpenCodeRuntimeAdapter(),
    store: space.store,
    connect: async (input) => {
      space.connects.push(input);
      return handleFor(space, options);
    },
    storedModels: async () => {
      space.models ??= storedModels(await (await connectOpenCodeApi({ url: space.fake.url, password: "secret" })).providers(space.dir));
      return space.models;
    },
    onEvent: (event) => events.push(event),
    ...(options.ask === false ? {} : { ask: async (prompt: BackendPrompt) => { asked.push(prompt); return options.answer ? options.answer(prompt) : { cancelled: true } as ExtensionUiAnswer; } }),
    permissionLevel: () => options.level ?? "full",
    ...(options.tools ? { tools: options.tools } : {}),
    ...(options.interruptMs !== undefined ? { timeouts: { interruptMs: options.interruptMs } } : {}),
  });
  backends.push(backend);
  await backend.start(options.resume ? "resume" : "create");
  return { backend, events, asked };
}

const until = (condition: () => unknown) => expect.poll(() => Boolean(condition()), { timeout: 10_000 }).toBe(true);
const sessionOf = (space: Scratch): string => [...space.fake.sessions.keys()].at(-1)!;
const prompts = (fake: FakeOpenCode2) => fake.requests.filter((request) => request.method === "POST" && /^\/api\/session\/[^/]+\/prompt$/u.test(request.path));
const posts = (fake: FakeOpenCode2, tail: string) => fake.requests.filter((request) => request.method === "POST" && request.path.endsWith(`/${tail}`));
const noticeOf = (events: ThreadRuntimeEvent[]) => events.filter((event): event is Extract<ThreadRuntimeEvent, { type: "notice" }> => event.type === "notice");

/** The head of a turn that has not answered yet: enough for the translator to follow it. */
function begin(turn: FakeTurn2): void {
  announcePrompt(turn);
  turn.emit("session.execution.started");
  turn.emit("session.inbox.delivered", { inboxID: turn.inboxId });
  turn.emit("session.step.started", { agent: turn.agent, model: turn.model, assistantMessageID: turn.assistantMessageId, started: Date.now() });
}

/** A turn that ends at once and sends no usage, so the session's own total stands. */
const bare: FakeScript2 = (turn) => {
  begin(turn);
  turn.emit("session.execution.succeeded");
};

/** A turn that asks before it answers. */
const asking = (ask: (turn: FakeTurn2) => Promise<void> | void, answer = "done"): FakeScript2 => async (turn) => {
  await ask(turn);
  await textTurn(answer)(turn);
};

const form = (fields: unknown[], title = "Questions") => ({ form: { title, fields } });
const pick = (options: string[], extra: Record<string, unknown> = {}) => ({
  key: "q0", title: "Pick", description: "Which one?", type: "string", custom: false,
  options: options.map((value) => ({ value, label: value.replace(/^opt-/u, "").toUpperCase() })),
  ...extra,
});

describe("OpenCodeThreadRuntimeBackend against a fake OpenCode 2 server", () => {
  it("holds a native child which outlives its parent, includes its result, and ignores duplicate end events", async () => {
    let turns = 0;
    const child = "ses_background_child";
    const space = await scratch({ script: (turn) => {
      announcePrompt(turn);
      turn.emit("session.execution.started");
      turn.emit("session.inbox.delivered", { inboxID: turn.inboxId });
      if (turns++ === 0) {
        space.fake.broadcast("session.created", { sessionID: child, parentID: turn.session.id, title: "Review" }, { directory: space.dir });
        space.fake.broadcast("session.execution.started", { sessionID: child }, { directory: space.dir });
      }
      turn.emit("session.execution.succeeded");
    } });
    const { backend } = await open(space);
    await backend.prompt({ text: "Start review", delivery: "prompt" });
    expect(backend.capabilities.background!.current()).toEqual([expect.objectContaining({ id: `opencode-child:${child}`, kind: "agent" })]);
    space.fake.broadcast("session.execution.succeeded", { sessionID: child }, { directory: space.dir });
    await vi.waitFor(() => expect(backend.capabilities.background!.current()[0]?.state).toBe("reported"));
    space.fake.broadcast("session.execution.succeeded", { sessionID: child }, { directory: space.dir });
    await backend.prompt({ text: "Handle review", delivery: "prompt" });
    expect(backend.capabilities.background!.current()).toEqual([]);
  });

  it("holds an unfinished shell past execution.succeeded and accepts its late tool.success", async () => {
    let turns = 0;
    let report!: () => void;
    const space = await scratch({ script: (turn) => {
      announcePrompt(turn);
      turn.emit("session.execution.started");
      turn.emit("session.inbox.delivered", { inboxID: turn.inboxId });
      if (turns++ === 0) {
        turn.emit("session.tool.input.started", { id: "build", name: "shell" });
        turn.emit("session.tool.called", { id: "build", input: { command: "npm test" } });
        report = () => turn.emit("session.tool.success", { id: "build", content: [{ type: "text", text: "passed" }] });
      }
      turn.emit("session.execution.succeeded");
    } });
    const { backend } = await open(space);
    await backend.prompt({ text: "Start tests", delivery: "prompt" });
    expect(backend.capabilities.background!.current()).toEqual([expect.objectContaining({ id: "build", kind: "command" })]);
    report();
    await vi.waitFor(() => expect(backend.capabilities.background!.current()[0]?.state).toBe("reported"));
    await backend.prompt({ text: "Handle tests", delivery: "prompt" });
    expect(backend.capabilities.background!.current()).toEqual([]);
  });

  it("creates a session on the first turn, streams the answer and keeps the messages, usage and model", async () => {
    const space = await scratch({ script: textTurn("pong", { cost: 0.25, tokens: { input: 1000, output: 50, reasoning: 10, cache: { read: 5, write: 1 } } }) });
    const { backend, events } = await open(space);
    const result = await backend.prompt({ text: "Reply with one word", delivery: "prompt", identity: { clientMessageId: "m1", clientTurnId: "t1" } });
    expect(result).toEqual({ assistantText: "pong" });

    const first = (type: string) => events.findIndex((event) => event.type === type);
    const order = ["user-message", "turn-started", "assistant-start", "assistant-delta", "assistant-end", "turn-settled"].map(first);
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "completed" });
    expect(events.some((event) => event.type === "usage")).toBe(true);
    expect((await backend.transcript()).map((message) => [message.role, message.text])).toEqual([["user", "Reply with one word"], ["assistant", "pong"]]);

    const created = space.fake.requests.filter((request) => request.method === "POST" && request.path === "/api/session");
    expect(created).toHaveLength(1);
    expect(created[0]!.body).toEqual({ location: { directory: space.dir }, permissions: rulesForLevelV2("full") });
    expect(created[0]!.body).not.toHaveProperty("title");
    // No Tau server was started for it, so nothing waits for MCP tools.
    expect(space.fake.requests.some((request) => request.path === "/api/mcp")).toBe(false);

    const view = backend.catalogView();
    expect(view.model).toMatchObject({ provider: "opencode", id: "space-bunny-free", name: "Space Bunny Free" });
    // Reasoning counts as output.
    expect(view.usage).toMatchObject({ turns: 1, costUsd: 0.25, inputTokens: 1000, outputTokens: 60, cacheReadTokens: 5, cacheWriteTokens: 1 });
    expect(view.contextUsage).toMatchObject({ tokens: 1066, contextWindow: 262144 });
    const stored = await space.store.get("tau-1");
    expect(stored).toMatchObject({ sessionId: sessionOf(space), observedModel: { provider: "opencode", id: "space-bunny-free" }, usage: { turns: 1, costUsd: 0.25 } });
    expect(stored!.messages.map((message) => message.text)).toEqual(["Reply with one word", "pong"]);
    expect(backend.providerSessionId).toBe(sessionOf(space));
  });

  it("closes its stream and the server handle with the thread", async () => {
    const space = await scratch();
    const { backend } = await open(space);
    await backend.prompt({ text: "Hi", delivery: "prompt" });
    expect(space.fake.listeners).toBe(1);
    expect(space.handles[0]!.closed).toBe(false);
    await backend.dispose();
    expect(space.handles[0]!.closed).toBe(true);
    await until(() => space.fake.listeners === 0);
  });

  it("posts the picked model and effort once, and again only when they change", async () => {
    const space = await scratch();
    const { backend } = await open(space);
    const models = () => posts(space.fake, "model");
    const say = (text: string) => backend.prompt({ text, delivery: "prompt" });
    await backend.capabilities.catalogWrite!.setModel("opencode", "space-bunny-free");
    await backend.capabilities.catalogWrite!.setThinkingLevel("high");
    expect(backend.catalogView()).toMatchObject({ model: { provider: "opencode", id: "space-bunny-free" }, thinkingLevel: "high", thinkingLevels: ["default", "low", "medium", "high"] });
    await say("one");
    expect(models().map((request) => request.body)).toEqual([{ model: { id: "space-bunny-free", providerID: "opencode", variant: "high" } }]);
    // The model is selected before the prompt reaches the session.
    expect(space.fake.requests.indexOf(models()[0]!)).toBeLessThan(space.fake.requests.indexOf(prompts(space.fake)[0]!));
    await say("two");
    expect(models()).toHaveLength(1);

    await backend.capabilities.catalogWrite!.setThinkingLevel("low");
    await say("three");
    expect(models().at(-1)!.body).toEqual({ model: { id: "space-bunny-free", providerID: "opencode", variant: "low" } });
    await backend.capabilities.catalogWrite!.setThinkingLevel("default");
    await say("four");
    expect(models().at(-1)!.body).toEqual({ model: { id: "space-bunny-free", providerID: "opencode" } });
    await backend.capabilities.catalogWrite!.setModel("github-copilot", "gpt-5.5");
    await say("five");
    expect(models()).toHaveLength(4);
    expect(models().at(-1)!.body).toEqual({ model: { id: "gpt-5.5", providerID: "github-copilot" } });
    expect(space.fake.sessions.get(sessionOf(space))!.model).toMatchObject({ id: "gpt-5.5", providerID: "github-copilot" });
    expect(backend.catalogView().model).toMatchObject({ provider: "github-copilot", id: "gpt-5.5", name: "GPT-5.5" });
    expect(await space.store.get("tau-1")).toMatchObject({ model: { provider: "github-copilot", id: "gpt-5.5" }, observedModel: { provider: "github-copilot", id: "gpt-5.5" } });

    await expect(backend.capabilities.catalogWrite!.setModel("opencode", "nope")).rejects.toThrow(/no model/u);
    await expect(backend.capabilities.catalogWrite!.setThinkingLevel("max")).rejects.toThrow(/no reasoning effort/u);

    // A resumed thread finds the model on the session and leaves it alone.
    await backend.dispose();
    const resumed = await open(space, { resume: true });
    await resumed.backend.prompt({ text: "six", delivery: "prompt" });
    expect(models()).toHaveLength(4);
  });

  it("switches the agent and the plan instruction with the mode, and the plan block reaches the transcript", async () => {
    const plan = "<proposed_plan>\n# Plan\n- one\n</proposed_plan>";
    const space = await scratch({ script: textTurn(plan) });
    const { backend } = await open(space);
    expect(backend.capabilities.mode!.modes()).toEqual(["plan"]);
    await backend.capabilities.mode!.set("plan");
    const result = await backend.prompt({ text: "Plan it", delivery: "prompt" });
    expect(result.assistantText).toContain("<proposed_plan>");
    expect((await backend.transcript()).at(-1)!.text).toBe(plan);

    const id = sessionOf(space);
    const entry = `/api/experimental/session/${id}/instructions/entries/tau-plan`;
    const before = space.fake.requests.slice(0, space.fake.requests.indexOf(prompts(space.fake)[0]!));
    expect(before.find((request) => request.path === `/api/session/${id}/agent`)?.body).toEqual({ agent: "plan" });
    expect(before.find((request) => request.method === "PUT" && request.path === entry)?.body).toEqual({ value: expect.stringContaining("<proposed_plan>") });
    expect(space.fake.sessions.get(id)).toMatchObject({ agent: "plan", instructionEntries: { "tau-plan": expect.stringContaining("<proposed_plan>") } });

    // Another plan turn changes nothing; leaving plan mode takes both back.
    await backend.prompt({ text: "More", delivery: "prompt" });
    expect(posts(space.fake, "agent")).toHaveLength(1);
    await backend.capabilities.mode!.set("default");
    await backend.prompt({ text: "Now do it", delivery: "prompt" });
    expect(posts(space.fake, "agent").at(-1)!.body).toEqual({ agent: "build" });
    expect(space.fake.requests.some((request) => request.method === "DELETE" && request.path === entry)).toBe(true);
    expect(space.fake.sessions.get(id)).toMatchObject({ agent: "build", instructionEntries: {} });
    await expect(backend.capabilities.mode!.set("nope")).rejects.toThrow(/no "nope" mode/u);
  });

  it("adopts OpenCode's title without replacing a manual name, and writes a renamed title back", async () => {
    const titles = ["Bildvorschau im Chat", "Anderer Titel"];
    const space = await scratch({ script: async (turn) => { const title = titles.shift(); if (title) turn.emit("session.renamed", { title }); await textTurn("ok")(turn); } });
    const { backend, events } = await open(space);
    await backend.prompt({ text: "Repariere die Bildvorschau", delivery: "prompt" });
    expect(backend.state()).toMatchObject({ title: "Bildvorschau im Chat", titleSource: "generated" });
    expect(await space.store.get("tau-1")).toMatchObject({ title: "Bildvorschau im Chat", titleSource: "generated" });
    expect(events.some((event) => event.type === "title")).toBe(true);
    await expect(backend.capabilities.titles!.title()).resolves.toBe("Bildvorschau im Chat");

    await backend.setTitle("Mein Titel", "renamed");
    const id = sessionOf(space);
    expect(space.fake.requests.filter((request) => request.method === "PATCH" && request.path === `/api/session/${id}`).at(-1)!.body).toEqual({ title: "Mein Titel" });
    expect(space.fake.sessions.get(id)!.title).toBe("Mein Titel");
    await backend.prompt({ text: "Weiter", delivery: "prompt" });
    expect(backend.state()).toMatchObject({ title: "Mein Titel", titleSource: "renamed" });
    expect(await space.store.get("tau-1")).toMatchObject({ title: "Mein Titel", titleSource: "renamed" });
  });

  it("names the session at creation when the user named the thread first, and does not write to a session it has not made", async () => {
    const space = await scratch();
    const { backend } = await open(space);
    await backend.setTitle("Vorab", "renamed");
    expect(space.fake.requests.filter((request) => request.method === "PATCH")).toEqual([]);
    await backend.prompt({ text: "Hi", delivery: "prompt" });
    expect(space.fake.requests.find((request) => request.method === "POST" && request.path === "/api/session")!.body).toEqual({ location: { directory: space.dir }, permissions: rulesForLevelV2("full"), title: "Vorab" });
  });

  it("starts with the access level's rules and ignores a name that OpenCode only left at its default", async () => {
    const space = await scratch({ script: async (turn) => { turn.emit("session.renamed", { title: "New session - 2026-10-12T00:00:00.000Z" }); await textTurn("ok")(turn); } });
    const { backend } = await open(space, { level: "read-only" });
    await backend.prompt({ text: "Look", delivery: "prompt" });
    expect(space.fake.requests.find((request) => request.method === "POST" && request.path === "/api/session")!.body).toMatchObject({ permissions: rulesForLevelV2("read-only") });
    expect(backend.state().title).toBeUndefined();
  });
});

describe("approvals on an OpenCode 2 thread", () => {
  const replyOf = (space: Scratch) => space.fake.requests.find((request) => /\/permission\/[^/]+\/reply$/u.test(request.path));

  it("asks before a command at the ask level and shows OpenCode's detail and the session grant", async () => {
    const space = await scratch({ script: replay2("permission") });
    const { backend, asked } = await open(space, { level: "ask", answer: () => ({ value: ALLOW }) });
    await backend.prompt({ text: "Run echo hello", delivery: "prompt" });
    expect(asked).toEqual([{ kind: "select", title: "OpenCode wants to run a command", message: "echo hello\nFor this session: echo *", options: [ALLOW, ALLOW_SESSION, DENY] }]);
    expect(replyOf(space)).toMatchObject({ method: "POST", path: expect.stringContaining(`/api/session/${sessionOf(space)}/permission/per_`), body: { decision: "once" } });
    expect(space.fake.requests.find((request) => request.method === "POST" && request.path === "/api/session")!.body).toMatchObject({ permissions: rulesForLevelV2("ask") });
    expect(space.fake.requests.some((request) => request.method === "PATCH")).toBe(false);
  });

  it("grants for this session through the session's rules, then replies once", async () => {
    const space = await scratch({ script: replay2("permission") });
    const { backend } = await open(space, { level: "ask", answer: () => ({ value: ALLOW_SESSION }) });
    await backend.prompt({ text: "Run echo hello", delivery: "prompt" });
    const id = sessionOf(space);
    const afterPrompt = space.fake.requests.slice(space.fake.requests.indexOf(prompts(space.fake)[0]!) + 1);
    const label = (request: (typeof afterPrompt)[number]) => request.method === "GET" && request.path === `/api/session/${id}` ? "GET session"
      : request.method === "PATCH" && request.path === `/api/session/${id}` ? "PATCH session"
        : /\/permission\/[^/]+\/reply$/u.test(request.path) ? "POST reply" : undefined;
    expect(afterPrompt.map(label).filter(Boolean)).toEqual(["GET session", "PATCH session", "POST reply"]);
    expect(afterPrompt.find((request) => label(request) === "PATCH session")!.body).toEqual({ permissions: [...rulesForLevelV2("ask"), { action: "shell", resource: "echo *", effect: "allow" }] });
    expect(afterPrompt.find((request) => label(request) === "POST reply")!.body).toEqual({ decision: "once" });
    expect(space.fake.sessions.get(id)!.permissions).toContainEqual({ action: "shell", resource: "echo *", effect: "allow" });
  });

  it.each([
    ["Deny", { value: DENY }],
    ["a dialog that is closed", { cancelled: true }],
    ["a typed answer", { value: "sure", typed: true }],
  ] as Array<[string, ExtensionUiAnswer]>)("rejects with a message after %s", async (_name, answer) => {
    const space = await scratch({ script: replay2("permission") });
    const { backend } = await open(space, { level: "ask", answer: () => answer });
    await backend.prompt({ text: "Run echo hello", delivery: "prompt" });
    expect(replyOf(space)!.body).toEqual({ decision: "reject", message: "The user declined this request." });
  });

  it("answers by itself at full access, and rejects without a dialog where the host cannot ask", async () => {
    const full = await scratch({ script: replay2("permission") });
    const first = await open(full);
    await first.backend.prompt({ text: "Run echo hello", delivery: "prompt" });
    expect(first.asked).toEqual([]);
    expect(replyOf(full)!.body).toEqual({ decision: "once" });

    const readOnly = await scratch({ script: replay2("permission") });
    const second = await open(readOnly, { level: "read-only", ask: false });
    await second.backend.prompt({ text: "Run echo hello", delivery: "prompt" });
    expect(replyOf(readOnly)!.body).toEqual({ decision: "reject", message: "The user declined this request." });
  });

  it("refuses to start a thread that must ask where the host cannot", async () => {
    const space = await scratch();
    const { backend } = await open(space, { level: "ask", ask: false });
    await expect(backend.prompt({ text: "Hi", delivery: "prompt" })).rejects.toThrow(/cannot ask for approvals/u);
    expect(prompts(space.fake)).toEqual([]);
  });

  it("answers a sub-agent's request and its own sub-agents', and leaves an unrelated session's alone", async () => {
    const space = await scratch();
    const asks = (turn: FakeTurn2) => {
      const dir = turn.session.directory;
      const created = (sessionID: string, parentID?: string) => turn.emit("session.created", { sessionID, projectID: "fake", location: { directory: dir }, ...(parentID ? { parentID } : {}) });
      const request = (sessionID: string, path: string) => void turn.ask("permission", { sessionID, action: "edit", resources: [path], save: [], metadata: { filepath: path } });
      created("ses_other");
      request("ses_other", "other.ts");
      created("ses_child", turn.session.id);
      request("ses_child", "src/a.ts");
      created("ses_grand", "ses_child");
      request("ses_grand", "src/b.ts");
    };
    space.fake.script = asking(asks);
    const { backend, asked } = await open(space, { level: "ask", answer: () => ({ value: ALLOW }) });
    await backend.prompt({ text: "Edit", delivery: "prompt" });
    // The fake keeps every request on the thread's session, so the replies themselves are answered 404 there.
    await until(() => space.fake.requests.filter((request) => /\/permission\/[^/]+\/reply$/u.test(request.path)).length >= 2);
    expect(asked.map((prompt) => prompt.kind === "select" ? prompt.message : undefined)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(space.fake.requests.filter((request) => /\/permission\/[^/]+\/reply$/u.test(request.path)).map((request) => request.path.split("/")[3]).sort()).toEqual(["ses_child", "ses_grand"]);
    expect(space.fake.requests.some((request) => request.path.startsWith("/api/session/ses_other/"))).toBe(false);
  });
});

describe("questions on an OpenCode 2 thread", () => {
  const replies: unknown[] = [];
  const asksOf = (...forms: unknown[]): FakeScript2 => asking(async (turn) => {
    for (const payload of forms) replies.push(await turn.ask("form", payload as Record<string, unknown>));
  });
  afterEach(() => { replies.length = 0; });
  const formRequests = (space: Scratch) => space.fake.requests.filter((request) => /\/form\//u.test(request.path) && request.method !== "GET");

  it("shows a select question with its labels and replies with the form's value", async () => {
    const space = await scratch({ script: asksOf(form([pick(["opt-a", "opt-b"])])) });
    const { backend, asked } = await open(space, { answer: () => ({ value: "B" }) });
    await backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(asked).toEqual([{ kind: "select", title: "[Pick] Which one?", options: ["A", "B"] }]);
    expect(formRequests(space)).toEqual([expect.objectContaining({ method: "POST", path: expect.stringMatching(/\/form\/frm_[^/]+\/reply$/u), body: { answer: { q0: "opt-b" } } })]);
    expect(replies).toEqual([{ answer: { q0: "opt-b" } }]);
  });

  it("answers the recorded question by its label", async () => {
    const space = await scratch({ script: replay2("question") });
    const { backend } = await open(space, { answer: () => ({ value: "Blue" }) });
    await backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(formRequests(space).map((request) => request.body)).toEqual([{ answer: { q0: "Blue" } }]);
  });

  it("turns a closed dialog into a dismissed form with a message", async () => {
    const space = await scratch({ script: asksOf(form([pick(["opt-a"])])) });
    const { backend } = await open(space, { answer: () => ({ cancelled: true }) });
    await backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(formRequests(space)).toEqual([expect.objectContaining({ method: "DELETE", query: { message: "The user dismissed this question." } })]);
    expect(replies).toEqual([{ cancelled: true, message: "The user dismissed this question." }]);
  });

  it("dismisses a form with a field it cannot show, naming why, without a dialog", async () => {
    const space = await scratch({ script: asksOf(
      form([{ key: "q0", type: "external", title: "Sign in", url: "https://example.com" }]),
      form([pick(["a"], { when: [{ key: "q1" }] })]),
      form([pick(["a"], { hidden: true })]),
      form([{ key: "q0", type: "file", title: "Upload" }]),
    ) });
    const { backend, asked } = await open(space, { answer: () => ({ value: "A" }) });
    await backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(asked).toEqual([]);
    expect(formRequests(space).map((request) => [request.method, request.query.message])).toEqual([
      ["DELETE", "Tau cannot answer a link to open."],
      ["DELETE", "Tau cannot answer a field that depends on another."],
      ["DELETE", "Tau cannot answer a hidden field."],
      ["DELETE", "Tau cannot answer a file value."],
    ]);
  });

  it("turns each answer into the field's own type", async () => {
    const fields = [
      { key: "ok", title: "Sure", description: "Go on?", type: "boolean" },
      { key: "count", title: "Count", description: "How many?", type: "integer", options: [] },
      { key: "ratio", title: "Ratio", description: "How much?", type: "number", options: [] },
      { key: "name", title: "Name", description: "Called?", type: "string", options: [] },
    ];
    const space = await scratch({ script: asksOf(form(fields)) });
    const answers: Record<string, string> = { "Go on?": "Yes", "How many?": "3.7", "How much?": "0.5", "Called?": "Ada" };
    const { backend, asked } = await open(space, { answer: (prompt) => ({ value: answers[(prompt.title ?? "").replace(/^\[[^\]]*\] /u, "")] ?? "" }) });
    await backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(asked).toHaveLength(4);
    expect(formRequests(space)[0]!.body).toEqual({ answer: { ok: true, count: 3, ratio: 0.5, name: "Ada" } });
  });

  it("answers a form that belongs to no session only on a server Tau started", async () => {
    const orphan = { form: { sessionID: "global", title: "An MCP server asks", fields: [pick(["opt-a", "opt-b"])] } };
    const script: FakeScript2 = asking(async (turn) => {
      void turn.ask("form", orphan);
      // The thread's own form is answered after it, so the orphan was handled by then.
      await turn.ask("form", form([pick(["x"])]));
    });

    const external = await scratch();
    external.fake.script = script;
    const outside = await open(external, { local: false, answer: () => ({ value: "B" }) });
    await outside.backend.prompt({ text: "Ask me", delivery: "prompt" });
    expect(outside.asked).toHaveLength(1);
    expect(external.fake.requests.some((request) => request.path.startsWith("/api/session/global/"))).toBe(false);

    const local = await scratch();
    local.fake.script = script;
    const own = await open(local, { local: true, answer: () => ({ value: "B" }) });
    await own.backend.prompt({ text: "Ask me", delivery: "prompt" });
    await until(() => local.fake.requests.some((request) => request.path.startsWith("/api/session/global/form/")));
    expect(own.asked).toHaveLength(2);
    expect(local.fake.requests.find((request) => request.path.startsWith("/api/session/global/form/"))).toMatchObject({ method: "POST", path: expect.stringMatching(/\/reply$/u), body: { answer: { q0: "opt-b" } } });
  });
});

describe("a turn's end on an OpenCode 2 thread", () => {
  it("interrupts a running tool through the server and settles as interrupted", async () => {
    const space = await scratch({ script: untilInterrupted });
    const { backend, events } = await open(space);
    const running = backend.prompt({ text: "Sleep", delivery: "prompt" });
    await until(() => events.some((event) => event.type === "tool-start"));
    expect(backend.state()).toMatchObject({ streaming: true, activeTools: ["bash"] });
    await backend.abort();
    await running;
    expect(posts(space.fake, "interrupt").map((request) => request.path)).toEqual([`/api/session/${sessionOf(space)}/interrupt`]);
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "interrupted" });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { id: "call_sleep", name: "bash", args: { command: "sleep 100" }, status: "error", output: "Interrupted." } });
    expect(backend.state()).toMatchObject({ streaming: false, idle: true });
  });

  it("closes the server handle when it never confirms the interrupt, and still ends the turn as interrupted", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const space = await scratch({
      script: async (turn) => {
        begin(turn);
        const ref = { assistantMessageID: turn.assistantMessageId, id: "call_sleep" };
        turn.emit("session.tool.input.started", { ...ref, name: "shell" });
        turn.emit("session.tool.called", { ...ref, input: { command: "sleep 100" }, executed: false });
        await held;
      },
    });
    const { backend, events } = await open(space, { interruptMs: 25 });
    try {
      const running = backend.prompt({ text: "Sleep", delivery: "prompt" });
      await until(() => events.some((event) => event.type === "tool-start"));
      await backend.abort();
      await running;
      expect(posts(space.fake, "interrupt")).toHaveLength(1);
      expect(space.handles[0]!.closed).toBe(true);
      expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "interrupted" });
      expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { id: "call_sleep", status: "error", output: "Interrupted." } });
      expect(backend.state().idle).toBe(true);
    } finally {
      release();
    }
  });

  it.each([
    ["the step's and the execution's message", "Rate limited", "Provider exploded", "Provider exploded"],
    ["the step's message when the execution names none", "Rate limited", undefined, "Rate limited"],
    ["a plain message when none is named", undefined, undefined, "OpenCode reported an error."],
  ])("reports a failed execution with %s", async (_name, step, execution, expected) => {
    const space = await scratch({
      script: (turn) => {
        begin(turn);
        if (step) turn.emit("session.step.failed", { error: { type: "provider", message: step } });
        turn.emit("session.execution.failed", { error: { type: "provider", ...(execution ? { message: execution } : {}) } });
      },
    });
    const { backend, events } = await open(space);
    await backend.prompt({ text: "Go", delivery: "prompt" });
    expect(noticeOf(events)).toContainEqual({ type: "notice", message: `OpenCode stopped: ${expected}`, level: "error" });
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "error", error: expected });
  });

  it("fails the running turn with a notice when the event stream drops", async () => {
    const space = await scratch({ script: untilInterrupted });
    const { backend, events } = await open(space);
    const running = backend.prompt({ text: "Sleep", delivery: "prompt" });
    await until(() => events.some((event) => event.type === "tool-start"));
    await space.fake.close();
    await running;
    expect(noticeOf(events).map((event) => event.message)).toContainEqual(expect.stringMatching(/^OpenCode stopped: Lost the connection to OpenCode/u));
    expect(events.find((event) => event.type === "turn-settled")).toMatchObject({ status: "error", error: expect.stringContaining("Lost the connection to OpenCode") });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { status: "error" } });
    expect(space.handles[0]!.closed).toBe(true);
  });

  it("fails the running turn when the server Tau started exits", async () => {
    const space = await scratch({ script: untilInterrupted });
    const { backend, events } = await open(space);
    const running = backend.prompt({ text: "Sleep", delivery: "prompt" });
    await until(() => events.some((event) => event.type === "tool-start"));
    space.connects[0]!.onExit(new Error("OpenCode's server exited with code 1."));
    await running;
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "error", error: "OpenCode's server exited with code 1." });
  });
});

describe("resuming an OpenCode 2 thread", () => {
  it("looks the stored session up, settles it, re-applies the rules and keeps the session", async () => {
    const space = await scratch();
    const first = await open(space);
    await first.backend.prompt({ text: "One", delivery: "prompt" });
    await first.backend.dispose();
    const id = (await space.store.get("tau-1"))!.sessionId!;
    expect(id).toBe(sessionOf(space));

    // OpenCode's total for the session stands in for the thread's own until a turn reports one.
    const session = space.fake.sessions.get(id)!;
    session.tokens = { input: 500, output: 40, reasoning: 0, cache: { read: 0, write: 0 } };
    session.cost = 1.5;
    space.fake.script = bare;
    const mark = space.fake.requests.length;
    const resumed = await open(space, { resume: true, level: "ask" });
    expect((await resumed.backend.transcript()).map((message) => message.text)).toEqual(["One", "pong"]);
    await resumed.backend.prompt({ text: "Two", delivery: "prompt" });

    const label = (request: (typeof space.fake.requests)[number]) => request.method === "GET" && request.path === `/api/session/${id}` ? "GET session"
      : request.method === "GET" && request.path === "/api/session/active" ? "GET active"
        : request.method === "PATCH" ? "PATCH session" : request.method === "POST" && request.path === "/api/session" ? "POST create" : undefined;
    const since = space.fake.requests.slice(mark);
    expect(since.map(label).filter(Boolean)).toEqual(["GET session", "GET active", "PATCH session"]);
    expect(since.find((request) => request.method === "PATCH")).toMatchObject({ path: `/api/session/${id}`, body: { permissions: rulesForLevelV2("ask") } });
    expect(sessionOf(space)).toBe(id);
    expect(space.fake.sessions.size).toBe(1);
    expect(resumed.backend.catalogView().usage).toMatchObject({ inputTokens: 500, outputTokens: 40, costUsd: 1.5, turns: 2 });
    expect(resumed.backend.providerSessionId).toBe(id);
  });

  it("stops a run an earlier connection left on the session before it prompts", async () => {
    const space = await scratch();
    const first = await open(space);
    await first.backend.prompt({ text: "One", delivery: "prompt" });
    await first.backend.dispose();
    const session = space.fake.sessions.get(sessionOf(space))!;
    session.running = true;
    const resumed = await open(space, { resume: true, sleep: async () => { session.running = false; } });
    await resumed.backend.prompt({ text: "Two", delivery: "prompt" });
    expect(posts(space.fake, "interrupt").map((request) => request.path)).toEqual([`/api/session/${session.id}/interrupt`]);
    expect(prompts(space.fake)).toHaveLength(2);
  });

  it("starts a new session with a notice when the server no longer has the stored one", async () => {
    const space = await scratch();
    const first = await open(space);
    await first.backend.prompt({ text: "One", delivery: "prompt" });
    await first.backend.dispose();
    const lost = sessionOf(space);
    space.fake.sessions.clear();

    const resumed = await open(space, { resume: true });
    await resumed.backend.prompt({ text: "Two", delivery: "prompt" });
    expect(noticeOf(resumed.events)).toContainEqual({ type: "notice", message: "OpenCode no longer has this conversation; a new one starts here.", level: "warning" });
    expect(sessionOf(space)).not.toBe(lost);
    expect((await space.store.get("tau-1"))!.sessionId).toBe(sessionOf(space));
    // The new session runs on the model the thread showed.
    expect(posts(space.fake, "model").at(-1)).toMatchObject({ path: `/api/session/${sessionOf(space)}/model`, body: { model: { id: "space-bunny-free", providerID: "opencode" } } });
    expect(space.fake.requests.filter((request) => request.method === "POST" && request.path === "/api/session")).toHaveLength(2);
  });

  it("does not take a session of another workspace", async () => {
    const space = await scratch();
    await space.store.ensure("tau-1", "/somewhere/else");
    const backend = new OpenCodeThreadRuntimeBackend("tau-1", space.dir, { adapter: createOpenCodeRuntimeAdapter(), store: space.store, connect: async () => { throw new Error("unused"); } });
    await expect(backend.start("resume")).rejects.toThrow(/another workspace/u);
  });
});

describe("prompts on an OpenCode 2 thread", () => {
  it("joins a steer to the running turn and runs a follow-up as the next turn", async () => {
    const steered: Array<{ text: string; delivery: string }> = [];
    const space = await scratch({
      script: async (turn) => {
        if (turn.body.text === "First") {
          begin(turn);
          const next = await turn.nextPrompt();
          steered.push({ text: next.text, delivery: next.delivery });
        }
        await textTurn(`done: ${turn.body.text}`)(turn);
      },
    });
    const { backend, events } = await open(space);
    const first = backend.prompt({ text: "First", delivery: "prompt" });
    await until(() => prompts(space.fake).length === 1);
    const later = backend.prompt({ text: "Then this", delivery: "followUp" });
    await until(() => events.filter((event) => event.type === "queue").at(-1)?.type === "queue" && (events.filter((event) => event.type === "queue").at(-1) as { followUp: string[] }).followUp.length === 1);
    expect(events.filter((event) => event.type === "queue").at(-1)).toEqual({ type: "queue", steering: [], followUp: ["Then this"] });
    // The follow-up waits behind the turn; nothing reached the server for it yet.
    expect(prompts(space.fake)).toHaveLength(1);
    await expect(backend.prompt({ text: "Also this", delivery: "steer" })).resolves.toEqual({});
    await Promise.all([first, later]);

    expect(steered).toEqual([{ text: "Also this", delivery: "steer" }]);
    expect(prompts(space.fake).map((request) => request.body)).toEqual([{ text: "First" }, { text: "Also this", delivery: "steer" }, { text: "Then this" }]);
    // The steer joined the first turn, so there are two turns, not three.
    expect(events.filter((event) => event.type === "turn-started")).toHaveLength(2);
    expect(events.filter((event) => event.type === "turn-settled")).toHaveLength(2);
    expect((await backend.transcript()).filter((message) => message.role === "assistant").map((message) => message.text)).toEqual(["done: First", "done: Then this"]);
  });

  it("sends an image as a data file on the prompt and names attached files in its text", async () => {
    const space = await scratch();
    const { backend } = await open(space);
    await backend.prompt({ text: "Look", delivery: "prompt", attachments: [{ kind: "image", mimeType: "image/png", data: "AAAA", name: "shot.png" }] as never });
    await backend.prompt({ text: "Read it", delivery: "prompt", attachments: [{ kind: "file", path: "/tmp/a.txt", name: "a.txt" }] as never });
    expect(prompts(space.fake).map((request) => request.body)).toEqual([
      { text: "Look", files: [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }] },
      { text: "Read it\n\nAttached files:\n- /tmp/a.txt" },
    ]);
    expect((await backend.transcript())[0]).toMatchObject({ role: "user", images: [{ mimeType: "image/png", data: "AAAA" }] });
  });

  it("limits the session's rules to the thread's tools, and to read-only without a tool that writes", async () => {
    const created = (space: Scratch) => (space.fake.requests.find((request) => request.method === "POST" && request.path === "/api/session")!.body as { permissions: Array<{ action: string; effect: string }> }).permissions;
    const readers = await scratch();
    const first = await open(readers, { tools: ["read", "grep"], level: "ask" });
    await first.backend.prompt({ text: "Look", delivery: "prompt" });
    expect(created(readers)).toEqual(rulesForLevelV2("read-only", ["read", "grep"]));
    const denied = created(readers).filter((rule) => rule.effect === "deny").map((rule) => rule.action);
    expect(denied).toEqual(expect.arrayContaining(["shell", "edit", "glob", "list", "websearch", "webfetch", "subagent"]));
    expect(denied).not.toContain("read");
    expect(denied).not.toContain("grep");
    expect(readers.connects[0]).toMatchObject({ threadId: "tau-1", tools: ["read", "grep"] });
    expect(await readers.store.get("tau-1")).toMatchObject({ tools: ["read", "grep"] });

    const writers = await scratch();
    const second = await open(writers, { tools: ["read", "bash"], level: "full" });
    await second.backend.prompt({ text: "Run", delivery: "prompt" });
    expect(created(writers)).toEqual(rulesForLevelV2("full", ["read", "bash"]));
    const writersDenied = created(writers).filter((rule) => rule.effect === "deny").map((rule) => rule.action);
    expect(writersDenied).toContain("edit");
    expect(writersDenied).not.toContain("shell");
  });
});

describe("Tau's MCP tools on an OpenCode 2 thread", () => {
  const listing = (space: Scratch) => space.fake.requests.filter((request) => request.method === "GET" && request.path === "/api/mcp");
  const tau = (status: string) => ({ name: "tau", status: { status } });

  it("checks that the server has connected Tau's tools before the first prompt", async () => {
    const space = await scratch({ mcp: [tau("connected")] });
    const { backend } = await open(space, { mcpServers: ["tau"] });
    await expect(backend.prompt({ text: "Hi", delivery: "prompt" })).resolves.toEqual({ assistantText: "pong" });
    expect(listing(space)).toEqual([expect.objectContaining({ query: { "location[directory]": space.dir } })]);
    const at = (request: object) => space.fake.requests.indexOf(request as never);
    expect(at(listing(space)[0]!)).toBeLessThan(at(prompts(space.fake)[0]!));
  });

  it("polls until the server leaves pending, and a failed server counts as settled", async () => {
    const pending = [tau("pending")];
    const waiting = await scratch({ mcp: pending });
    const first = await open(waiting, { mcpServers: ["tau"], sleep: async () => { pending[0]!.status.status = "connected"; } });
    await first.backend.prompt({ text: "Hi", delivery: "prompt" });
    expect(listing(waiting)).toHaveLength(2);
    expect(waiting.fake.requests.indexOf(listing(waiting)[1]!)).toBeLessThan(waiting.fake.requests.indexOf(prompts(waiting.fake)[0]!));

    const failing = await scratch({ mcp: [tau("failed")] });
    const second = await open(failing, { mcpServers: ["tau"] });
    await second.backend.prompt({ text: "Hi", delivery: "prompt" });
    expect(listing(failing)).toHaveLength(1);
  });

  it("goes on without the tools when the server never lists them", async () => {
    const space = await scratch({ mcp: [] });
    const { backend } = await open(space, { mcpServers: ["tau"] });
    await expect(backend.prompt({ text: "Hi", delivery: "prompt" })).resolves.toEqual({ assistantText: "pong" });
    expect(listing(space).length).toBeGreaterThan(1);
    expect(prompts(space.fake)).toHaveLength(1);
  });

  it("waits again each time the thread reopens its session", async () => {
    const space = await scratch({ mcp: [tau("connected")] });
    const first = await open(space, { mcpServers: ["tau"] });
    await first.backend.prompt({ text: "Hi", delivery: "prompt" });
    await first.backend.dispose();
    const resumed = await open(space, { mcpServers: ["tau"], resume: true });
    await resumed.backend.prompt({ text: "Again", delivery: "prompt" });
    expect(listing(space)).toHaveLength(2);
  });
});

describe("the same backend on an OpenCode 1 server", () => {
  it("creates a session and streams an answer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tau-opencode-backend-v1-"));
    directories.push(dir);
    const fake = await startFakeOpenCode({ password: "secret" });
    fakes.push(fake);
    const handles: OpenCodeServerHandle[] = [];
    const backend = new OpenCodeThreadRuntimeBackend("tau-1", dir, {
      adapter: createOpenCodeRuntimeAdapter(),
      store: new OpenCodeSessionStore({ filePath: join(dir, "opencode-runtime-sessions.json") }),
      connect: async () => { handles.push(await connectOpenCodeServer(fake.url, "secret")); return handles.at(-1)!; },
      permissionLevel: () => "full",
    });
    backends.push(backend);
    await backend.start("create");
    await expect(backend.prompt({ text: "Reply with one word", delivery: "prompt" })).resolves.toEqual({ assistantText: "ok" });
    expect(handles[0]!.api.generation).toBe(1);
    expect(fake.requests.some((request) => request.method === "POST" && request.path === "/session")).toBe(true);
  });
});
