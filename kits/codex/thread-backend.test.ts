import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { TurnActivityStore, type BackendPrompt, type ExtensionUiAnswer, type RuntimePermissionLevel, type ThreadRuntimeEvent, type UiMessage, type UiToolRun } from "tau/host-extension";
import { CodexAppServer } from "./app-server.js";
import { ALLOW, ALLOW_SESSION } from "./approvals.js";
import { spawnRpcProcess } from "./rpc.js";
import { createCodexRuntimeAdapter } from "./runtime-adapter.js";
import { CodexSessionStore } from "./session-store.js";
import { CodexThreadRuntimeBackend, storedModel, userInput } from "./thread-backend.js";
import frames from "./fixtures/app-server-frames.json" with { type: "json" };

/**
 * The backend against `fixtures/stub-app-server.mjs`, a real child process
 * that replays turns recorded from codex-cli 0.154.0.
 */
const STUB = fileURLToPath(new URL("./fixtures/stub-app-server.mjs", import.meta.url));
const directories: string[] = [];
const backends: CodexThreadRuntimeBackend[] = [];

afterEach(async () => {
  await Promise.all(backends.splice(0).map((backend) => backend.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), "tau-codex-backend-"));
  directories.push(dir);
  return { dir, log: join(dir, "stub.log"), threads: join(dir, "threads.json"), store: new CodexSessionStore({ filePath: join(dir, "codex-runtime-sessions.json") }) };
}

type Scratch = Awaited<ReturnType<typeof scratch>>;

async function open(space: Scratch, options: { level?: RuntimePermissionLevel; answer?: (prompt: BackendPrompt) => Promise<ExtensionUiAnswer> | ExtensionUiAnswer; resume?: boolean; script?: string[]; tools?: string[]; activity?: TurnActivityStore } = {}) {
  const events: ThreadRuntimeEvent[] = [];
  const asked: BackendPrompt[] = [];
  const backend = new CodexThreadRuntimeBackend("tau-1", space.dir, {
    adapter: createCodexRuntimeAdapter(),
    store: space.store,
    openSession: (input) => CodexAppServer.open({
      command: process.execPath,
      cwd: input.cwd,
      env: { ...process.env, STUB_LOG: space.log, STUB_THREADS: space.threads, CODEX_HOME: join(space.dir, "home") },
      clientVersion: "test",
      spawn: (spawn) => spawnRpcProcess({ ...spawn, args: options.script ?? [STUB, ...spawn.args] }),
      onNotification: input.onNotification,
      onRequest: input.onRequest,
      onExit: input.onExit,
    }),
    models: async () => frames.models.map(storedModel),
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

async function sent(space: Scratch): Promise<Array<{ method?: string; params?: Record<string, unknown>; answered?: string; result?: unknown }>> {
  return (await readFile(space.log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
}

describe("CodexThreadRuntimeBackend before its first turn", () => {
  const unopened = async (configured?: { model?: string; effort?: string }) => {
    const space = await scratch();
    const backend = new CodexThreadRuntimeBackend("tau-1", space.dir, {
      adapter: createCodexRuntimeAdapter("codex@work"),
      store: space.store,
      instance: "work",
      openSession: async () => { throw new Error("no session before the first turn"); },
      storedModels: async () => frames.models.map(storedModel),
      ...(configured ? { configuredModel: async () => configured } : {}),
    });
    backends.push(backend);
    await backend.start("create");
    return { backend, space };
  };

  it("shows the model and effort the home's config.toml sets, not the account's default", async () => {
    const { backend } = await unopened({ model: "gpt-5.6-luna", effort: "low" });
    expect(backend.catalogView()).toMatchObject({ model: { provider: "openai", id: "gpt-5.6-luna" }, thinkingLevel: "default (low)" });
    expect(backend.catalogView().thinkingLevels).toEqual(["default (low)", "low", "medium", "high", "xhigh", "max"]);
  });

  it("falls back to the account's default model without a config.toml", async () => {
    const { backend } = await unopened();
    expect(backend.catalogView()).toMatchObject({ model: { id: "gpt-6-astra" }, thinkingLevel: "default (medium)" });
  });

  it("carries its instance's kind and keeps its record on that instance", async () => {
    const { backend, space } = await unopened();
    expect(backend.kind).toBe("codex@work");
    await expect(space.store.get("tau-1")).resolves.toMatchObject({ instance: "work" });
    await expect(space.store.list("default")).resolves.toEqual([]);
  });
});

describe("CodexThreadRuntimeBackend against the app-server stub", () => {
  it("starts a Codex thread, streams the answer and keeps both messages and the usage", async () => {
    const space = await scratch();
    const { backend, events } = await open(space);
    const result = await backend.prompt({ text: "Reply with exactly one word: hello.", delivery: "prompt", identity: { clientMessageId: "m1", clientTurnId: "t1" } });
    expect(result).toEqual({ assistantText: "hello" });
    const types = events.map((event) => event.type);
    expect(types[0]).toBe("user-message");
    expect(types).toContain("assistant-delta");
    expect(types.at(-2)).toBe("turn-settled");
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "completed" });
    expect((await backend.transcript()).map((message) => [message.role, message.text])).toEqual([["user", "Reply with exactly one word: hello."], ["assistant", "hello"]]);
    const view = backend.catalogView();
    expect(view.model).toEqual({ provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6-Luna" });
    // The effort Codex reported for the thread (the user's config) names the default.
    expect(view.thinkingLevels).toEqual(["default (low)", "low", "medium", "high", "xhigh", "max"]);
    expect(view.usage).toMatchObject({ turns: 1, costUsd: 0 });
    expect(view.usage!.totalTokens).toBeGreaterThan(0);
    const stored = await space.store.get("tau-1");
    expect(stored?.codexThreadId).toMatch(/^thread-/u);
    expect(stored?.usage?.turns).toBe(1);
    // Tau's access level travels with every turn; full access runs without a sandbox.
    const turn = (await sent(space)).find((message) => message.method === "turn/start");
    expect(turn?.params).toMatchObject({ approvalPolicy: "never", sandboxPolicy: { type: "dangerFullAccess" } });
  });

  it("asks before a command at ask level, answers Codex with the choice and shows the command as a card", async () => {
    const space = await scratch();
    const { backend, events, asked } = await open(space, { level: "ask", answer: () => ({ value: ALLOW }) });
    await backend.prompt({ text: "Run it [scenario:command]", delivery: "prompt" });
    expect(asked).toEqual([expect.objectContaining({ kind: "select", title: "Codex wants to run a command", message: expect.stringContaining("echo tau-ok > out.txt && cat out.txt") })]);
    const log = await sent(space);
    expect(log.find((message) => message.answered === "item/commandExecution/requestApproval")?.result).toEqual({ decision: "accept" });
    expect(log.find((message) => message.method === "thread/start")?.params).toMatchObject({ approvalPolicy: "untrusted", sandbox: "workspace-write" });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { name: "bash", status: "done", output: "tau-ok\n" } });
  });

  it("names the file an edit would write and passes an allowance for the session", async () => {
    const space = await scratch();
    const { backend, asked } = await open(space, { level: "ask", answer: () => ({ value: ALLOW_SESSION }) });
    await backend.prompt({ text: "Write it [scenario:edit]", delivery: "prompt" });
    expect(asked[0]?.title).toBe(`Codex wants to edit ${space.dir}/note.txt`);
    expect((await sent(space)).find((message) => message.answered === "item/fileChange/requestApproval")?.result).toEqual({ decision: "acceptForSession" });
  });

  it("interrupts the running turn on abort and closes its open tool", async () => {
    const space = await scratch();
    let approved!: () => void;
    const approval = new Promise<void>((resolve) => { approved = resolve; });
    const { backend, events } = await open(space, { level: "ask", answer: () => { approved(); return { value: ALLOW }; } });
    const run = backend.prompt({ text: "Run it [scenario:interrupt]", delivery: "prompt" });
    await approval;
    expect(backend.state().streaming).toBe(true);
    await backend.abort();
    await run;
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "interrupted" });
    expect(events.find((event) => event.type === "tool-end")).toMatchObject({ tool: { name: "bash", status: "error", output: "Interrupted." } });
    expect((await sent(space)).some((message) => message.method === "turn/interrupt")).toBe(true);
    expect(backend.state().streaming).toBe(false);
  });

  it("settles the turn with the reason when Codex dies in the middle of it", async () => {
    const space = await scratch();
    const { backend, events } = await open(space);
    await backend.prompt({ text: "Go [scenario:crash]", delivery: "prompt" });
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "error", error: "Codex exited with code 3.\nstub: gone" });
    expect(events).toContainEqual({ type: "notice", message: "Codex exited with code 3.\nstub: gone", level: "error" });
    // The next prompt spawns a new app-server and resumes the same Codex thread.
    await backend.prompt({ text: "Again.", delivery: "prompt" });
    expect(events.filter((event) => event.type === "turn-settled").at(-1)).toEqual({ type: "turn-settled", status: "completed" });
  });

  it("fails the turn with the reason when Codex dies before its handshake", async () => {
    const space = await scratch();
    const { backend, events } = await open(space, { script: ["-e", "process.stderr.write('stub: no login\\n'); process.exit(4)"] });
    await expect(backend.prompt({ text: "Hello.", delivery: "prompt" })).rejects.toThrow("Codex exited with code 4.\nstub: no login");
    expect(events.find((event) => event.type === "turn-settled")).toEqual({ type: "turn-settled", status: "error", error: "Codex exited with code 4.\nstub: no login" });
    expect(events.filter((event) => event.type === "notice")).toEqual([
      { type: "notice", message: "Codex reported an error: Codex exited with code 4.\nstub: no login", level: "error" },
    ]);
    expect(backend.state().streaming).toBe(false);
  });

  it("resumes the same Codex thread in a new process after a restart", async () => {
    const space = await scratch();
    const first = await open(space);
    await first.backend.prompt({ text: "Reply with exactly one word: hello.", delivery: "prompt" });
    await first.backend.dispose();
    const codexThreadId = (await space.store.get("tau-1"))?.codexThreadId;

    const second = await open(space, { resume: true });
    expect((await second.backend.transcript()).map((message) => message.text)).toEqual(["Reply with exactly one word: hello.", "hello"]);
    await second.backend.prompt({ text: "Again.", delivery: "prompt" });
    const resumes = (await sent(space)).filter((message) => message.method === "thread/resume");
    expect(resumes.map((message) => message.params?.threadId)).toEqual([codexThreadId]);
    expect(second.events.some((event) => event.type === "notice")).toBe(false);
    expect(second.backend.catalogView().usage?.turns).toBe(2);
  });

  it("keeps a turn's tool cards for the next open, anchored to a message the transcript shows again", async () => {
    const space = await scratch();
    const activity = new TurnActivityStore({ directory: join(space.dir, "activity") });
    const first = await open(space, { activity });
    const history = first.backend.capabilities.activityHistory!;
    expect(await history.load()).toEqual([]);
    await first.backend.prompt({ text: "Run it [scenario:command]", delivery: "prompt", identity: { clientMessageId: "c1", clientTurnId: "t1" } });
    // What the host records: the turn's tools, after the last message shown before the first of them.
    const shown: UiMessage[] = [];
    let anchor: string | undefined;
    const tools: UiToolRun[] = [];
    for (const event of first.events) {
      if (event.type === "user-message" || event.type === "assistant-end") shown.push(event.message);
      if (event.type === "tool-start") anchor ??= shown.at(-1)?.id;
      if (event.type === "tool-end") tools.push(event.tool);
    }
    expect(anchor).toBeDefined();
    await history.save({ id: "activity-tau-1-1", anchorMessageId: anchor!, status: "completed", tools });
    await first.backend.dispose();

    const second = await open(space, { resume: true, activity });
    const [entry] = await second.backend.capabilities.activityHistory!.load();
    expect(entry).toMatchObject({ status: "completed", anchorMessageId: anchor, tools: [{ name: "bash", status: "done", output: "tau-ok\n" }] });
    expect((await second.backend.transcript()).map((message) => message.id)).toEqual(shown.map((message) => message.id));
  });

  it("starts a new Codex thread when the old one is gone, and says so", async () => {
    const space = await scratch();
    await space.store.ensure("tau-1", space.dir);
    await space.store.setCodexThread("tau-1", space.dir, "thread-vanished");
    const { backend, events } = await open(space, { resume: true });
    await backend.prompt({ text: "Hello.", delivery: "prompt" });
    expect(events).toContainEqual({ type: "notice", message: "Codex no longer has this conversation; a new one starts here.", level: "warning" });
    expect((await space.store.get("tau-1"))?.codexThreadId).not.toBe("thread-vanished");
  });

  it("sends the chosen model and effort with a turn, and runs read-only in Codex's read-only sandbox", async () => {
    const space = await scratch();
    const { backend } = await open(space, { level: "read-only" });
    await backend.models();
    await backend.capabilities.catalogWrite!.setModel("openai", "gpt-5.5");
    await backend.capabilities.catalogWrite!.setThinkingLevel("low");
    await expect(backend.capabilities.catalogWrite!.setThinkingLevel("ultra")).rejects.toThrow("no reasoning effort");
    await backend.prompt({ text: "Hello.", delivery: "prompt" });
    const turn = (await sent(space)).find((message) => message.method === "turn/start");
    expect(turn?.params).toMatchObject({ model: "gpt-5.5", effort: "low", approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
    expect(await space.store.get("tau-1")).toMatchObject({ model: "gpt-5.5", effort: "low" });
  });
});

describe("plan mode", () => {
  it("runs a turn in Codex's plan collaboration mode, keeps the mode, and leaves it explicitly", async () => {
    const space = await scratch();
    const { backend } = await open(space);
    const mode = backend.capabilities.mode!;
    expect(mode.modes()).toEqual(["plan"]);
    expect(mode.current()).toBe("default");
    await backend.models();
    await backend.capabilities.catalogWrite!.setModel("openai", "gpt-5.5");
    await mode.set("plan");
    await expect(mode.set("review")).rejects.toThrow('no "review" mode');
    await backend.prompt({ text: "Hello.", delivery: "prompt" });
    const starts = async () => (await sent(space)).filter((message) => message.method === "turn/start");
    expect((await starts())[0]?.params?.collaborationMode).toEqual({ mode: "plan", settings: { model: "gpt-5.5", reasoning_effort: null, developer_instructions: null } });
    expect(await space.store.get("tau-1")).toMatchObject({ mode: "plan" });
    await mode.set("default");
    await backend.prompt({ text: "Hello.", delivery: "prompt" });
    expect((await starts())[1]?.params?.collaborationMode).toMatchObject({ mode: "default" });
    expect((await space.store.get("tau-1"))?.mode).toBeUndefined();
  });
});

describe("a Codex thread restricted to some tools", () => {
  it("runs read-only without a tool that writes, whatever the workbench allows", async () => {
    const space = await scratch();
    const { backend } = await open(space, { tools: ["read", "grep"] });
    await backend.prompt({ text: "Hello.", delivery: "prompt" });
    await backend.dispose();
    const resumed = await open(space, { resume: true });
    await resumed.backend.prompt({ text: "Again.", delivery: "prompt" });
    const turns = (await sent(space)).filter((message) => message.method === "turn/start");
    expect(turns.map((turn) => turn.params?.sandboxPolicy)).toEqual([{ type: "readOnly" }, { type: "readOnly" }]);
    expect((await space.store.get("tau-1"))?.tools).toEqual(["read", "grep"]);
  });

  it("keeps the workbench's level when the list names a tool that writes", async () => {
    const space = await scratch();
    const { backend } = await open(space, { tools: ["read", "edit"] });
    await backend.prompt({ text: "Hello.", delivery: "prompt" });
    const turn = (await sent(space)).find((message) => message.method === "turn/start");
    expect(turn?.params).toMatchObject({ sandboxPolicy: { type: "dangerFullAccess" } });
  });
});

describe("userInput", () => {
  it("names attached files by path and sends images as data URLs", () => {
    expect(userInput("Look", [
      { kind: "file", name: "a.pdf", mimeType: "application/pdf", path: "/repo/a.pdf", size: 1 },
      { kind: "image", name: "b.png", mimeType: "image/png", data: "AAAA", size: 3 },
    ])).toEqual([
      { type: "text", text: "Look\n\nAttached files:\n- /repo/a.pdf", text_elements: [] },
      { type: "image", url: "data:image/png;base64,AAAA" },
    ]);
  });
});
