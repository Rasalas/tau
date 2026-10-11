import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { OpenCodeApi } from "./api.js";
import type { OpenCodeTokens } from "./client.js";
import { startFakeOpenCode, type FakeOpenCode } from "./fixtures/fake-server.js";
import { startFakeOpenCode2, type FakeOpenCode2 } from "./fixtures/fake-server-v2.js";
import { boundedMessages, importOpenCodeSessions, scanOpenCodeSessions } from "./history-import.js";
import { connectOpenCodeServer } from "./server.js";
import { OpenCodeSessionStore } from "./session-store.js";

type Entry =
  | { user: string }
  | { assistant: string; model?: { providerID: string; id: string } }
  /** An assistant message that only called tools. */
  | { tool: true; model?: { providerID: string; id: string } }
  /** Text OpenCode added for the model, which the user never wrote. */
  | { synthetic: string };

interface Seed {
  id: string;
  directory: string;
  title?: string;
  parentId?: string;
  archived?: boolean;
  created?: number;
  updated: number;
  tokens?: OpenCodeTokens;
  cost?: number;
  entries?: Entry[];
}

/** Puts a session on a server of one generation. */
interface Generation {
  name: string;
  /**
   * The client pages a list by cursor alone, without the page size. OpenCode 2's
   * fake then answers 100 a page, which the client takes for the last page.
   */
  cursorKeepsPageSize: boolean;
  start(): Promise<{ url: string; close(): Promise<void>; seed(seed: Seed): void }>;
}

const TOKENS: OpenCodeTokens = { input: 100, output: 20, reasoning: 5, cache: { read: 7, write: 3 } };
const directories: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const generations: Generation[] = [
  {
    name: "OpenCode 1",
    cursorKeepsPageSize: true,
    async start() {
      const fake: FakeOpenCode = await startFakeOpenCode({ password: "pw" });
      return {
        url: fake.url,
        close: () => fake.close(),
        seed(seed) {
          const session = fake.addSession({
            id: seed.id,
            directory: seed.directory,
            title: seed.title ?? "",
            ...(seed.parentId ? { parentID: seed.parentId } : {}),
            time: { created: seed.created ?? seed.updated, updated: seed.updated, ...(seed.archived ? { archived: seed.updated } : {}) } as never,
            ...(seed.tokens ? { tokens: seed.tokens as never } : {}),
            ...(seed.cost !== undefined ? { cost: seed.cost } : {}),
          });
          (seed.entries ?? []).forEach((entry, index) => {
            const info = { id: `msg_${seed.id}_${index}`, sessionID: seed.id, time: { created: 1_000 + index } };
            if ("user" in entry) session.messages.push({ info: { ...info, role: "user" }, parts: [{ id: "p", type: "text", text: entry.user }] });
            else if ("synthetic" in entry) session.messages.push({ info: { ...info, role: "user" }, parts: [{ id: "p", type: "text", text: entry.synthetic, synthetic: true }] });
            else if ("assistant" in entry) {
              session.messages.push({
                info: { ...info, role: "assistant", ...(entry.model ? { providerID: entry.model.providerID, modelID: entry.model.id } : {}) },
                parts: [{ id: "r", type: "reasoning", text: "thinking" }, { id: "p", type: "text", text: entry.assistant }],
              });
            } else {
              session.messages.push({
                info: { ...info, role: "assistant", ...(entry.model ? { providerID: entry.model.providerID, modelID: entry.model.id } : {}) },
                parts: [{ id: "t", type: "tool", tool: "bash", state: { status: "completed" } }],
              });
            }
          });
        },
      };
    },
  },
  {
    name: "OpenCode 2",
    cursorKeepsPageSize: false,
    async start() {
      const fake: FakeOpenCode2 = await startFakeOpenCode2({ password: "pw" });
      return {
        url: fake.url,
        close: () => fake.close(),
        seed(seed) {
          const session = fake.addSession({
            id: seed.id,
            directory: seed.directory,
            ...(seed.title ? { title: seed.title } : {}),
            ...(seed.parentId ? { parentID: seed.parentId } : {}),
            time: { created: seed.created ?? seed.updated, updated: seed.updated, ...(seed.archived ? { archived: seed.updated } : {}) } as never,
            ...(seed.tokens ? { tokens: seed.tokens as never } : {}),
            ...(seed.cost !== undefined ? { cost: seed.cost } : {}),
          });
          (seed.entries ?? []).forEach((entry, index) => {
            const base = { id: `msg_${seed.id}_${String(index).padStart(5, "0")}`, time: { created: 1_000 + index } };
            const model = "model" in entry && entry.model ? { model: { id: entry.model.id, providerID: entry.model.providerID } } : {};
            if ("user" in entry) session.messages.push({ ...base, type: "user", text: entry.user });
            else if ("synthetic" in entry) session.messages.push({ ...base, type: "synthetic", text: entry.synthetic });
            else if ("assistant" in entry) session.messages.push({ ...base, type: "assistant", ...model, content: [{ type: "reasoning", text: "thinking" }, { type: "text", text: entry.assistant }] });
            else session.messages.push({ ...base, type: "assistant", ...model, content: [{ type: "tool", id: "c", name: "shell", state: { status: "completed" } }] });
          });
        },
      };
    },
  },
];

async function setup(generation: Generation) {
  const server = await generation.start();
  closers.push(server.close);
  const api = (await connectOpenCodeServer(server.url, "pw")).api;
  const dir = await mkdtemp(join(tmpdir(), "tau-opencode-import-"));
  directories.push(dir);
  const store = new OpenCodeSessionStore({ filePath: join(dir, "opencode-runtime-sessions.json") });
  return { server, api, store };
}

describe.each(generations)("importing OpenCode's own sessions, $name", (generation) => {
  it("scans top-level sessions of every project, newest first, and leaves out sub-agents and archived ones", async () => {
    const { server, api } = await setup(generation);
    server.seed({ id: "ses_old", directory: "/work/a", title: "Old one", updated: 1_000, created: 900 });
    server.seed({ id: "ses_new", directory: "/work/b", title: "New one", updated: 3_000 });
    server.seed({ id: "ses_child", directory: "/work/a", title: "Sub", parentId: "ses_new", updated: 4_000 });
    server.seed({ id: "ses_archived", directory: "/work/a", title: "Gone", archived: true, updated: 5_000 });
    server.seed({ id: "ses_mid", directory: "/work/a", title: "Mid", updated: 2_000 });

    const { sessions, truncated } = await scanOpenCodeSessions(api, (id) => id === "ses_mid");
    expect(truncated).toBe(false);
    expect(sessions).toEqual([
      { path: "ses_new", sessionId: "ses_new", cwd: "/work/b", title: "New one", updatedAt: 3_000, imported: false },
      { path: "ses_mid", sessionId: "ses_mid", cwd: "/work/a", title: "Mid", updatedAt: 2_000, imported: true },
      { path: "ses_old", sessionId: "ses_old", cwd: "/work/a", title: "Old one", updatedAt: 1_000, imported: false },
    ]);
  });

  it("shows a session without a name, or with the name OpenCode starts with, as untitled, and cuts a long title", async () => {
    const { server, api } = await setup(generation);
    server.seed({ id: "ses_none", directory: "/w", updated: 5 });
    server.seed({ id: "ses_default", directory: "/w", title: "New session - 2026-10-10T12:00:00.000Z", updated: 4 });
    server.seed({ id: "ses_child_default", directory: "/w", title: "Child session - 2026-10-10T12:00:00.000Z", updated: 3 });
    server.seed({ id: "ses_long", directory: "/w", title: "x".repeat(150), updated: 2 });
    const { sessions } = await scanOpenCodeSessions(api, () => false);
    expect(Object.fromEntries(sessions.map((session) => [session.sessionId, session.title]))).toEqual({
      ses_none: "Untitled conversation",
      ses_default: "Untitled conversation",
      ses_child_default: "Untitled conversation",
      ses_long: "x".repeat(100),
    });
  });

  // The page after a cursor carries no limit, so a list of more than 300 sessions stops early on OpenCode 2.
  (generation.cursorKeepsPageSize ? it : it.fails)("reports a scan cut off at 500 sessions and keeps the newest", async () => {
    const { server, api } = await setup(generation);
    for (let index = 0; index < 501; index += 1) server.seed({ id: `ses_${String(index).padStart(4, "0")}`, directory: "/w", title: `s${index}`, updated: 10_000 + index });
    const { sessions, truncated } = await scanOpenCodeSessions(api, () => false);
    expect(truncated).toBe(true);
    expect(sessions).toHaveLength(500);
    expect(sessions[0]).toMatchObject({ sessionId: "ses_0500", updatedAt: 10_500 });
  });

  it("imports the visible conversation with its model, usage, title and update time", async () => {
    const { server, api, store } = await setup(generation);
    server.seed({
      id: "ses_a", directory: "/work/app", title: "Fix the flaky test", updated: 7_000, tokens: TOKENS, cost: 0.02,
      entries: [
        { user: "  Fix the flaky test  " },
        { synthetic: "<file>read</file>" },
        { tool: true, model: { providerID: "opencode", id: "early-model" } },
        { assistant: "First part.", model: { providerID: "opencode", id: "early-model" } },
        { tool: true, model: { providerID: "opencode", id: "early-model" } },
        { assistant: "Second part.", model: { providerID: "opencode", id: "late-model" } },
        { user: "Thanks" },
        { assistant: "Welcome.", model: { providerID: "github-copilot", id: "gpt-5.5" } },
      ],
    });
    const outcome = await importOpenCodeSessions(api, ["ses_a"], store);
    expect(outcome).toEqual({ imported: [expect.any(String)], skipped: 0, failed: [] });
    const [record] = await store.list();
    expect(record).toMatchObject({
      sessionId: "ses_a", cwd: "/work/app", title: "Fix the flaky test", titleSource: "derived", updatedAt: 7_000,
      observedModel: { provider: "github-copilot", id: "gpt-5.5" },
      // Reasoning counts as output; the thread has two user turns.
      usage: { inputTokens: 100, outputTokens: 25, cacheReadTokens: 7, cacheWriteTokens: 3, totalTokens: 135, costUsd: 0.02, turns: 2 },
    });
    // Consecutive assistant messages join, tool-only ones and added text leave no trace.
    expect(record!.messages.map((message) => [message.role, message.text])).toEqual([
      ["user", "Fix the flaky test"],
      ["assistant", "First part.\n\nSecond part."],
      ["user", "Thanks"],
      ["assistant", "Welcome."],
    ]);
    expect(record!.messages.every((message) => typeof message.timestamp === "number")).toBe(true);
  });

  it("takes the title from the first message when OpenCode's name is a default one or missing", async () => {
    const { server, api, store } = await setup(generation);
    server.seed({ id: "ses_default", directory: "/w", title: "New session - 2026-10-10T12:00:00.000Z", updated: 3, entries: [{ user: "\n  Rename the module  \nplease" }, { assistant: "ok" }] });
    server.seed({ id: "ses_none", directory: "/w", updated: 2, entries: [{ user: "y".repeat(150) }] });
    server.seed({ id: "ses_long", directory: "/w", title: "z".repeat(150), updated: 1, entries: [{ user: "hi" }] });
    await importOpenCodeSessions(api, ["ses_default", "ses_none", "ses_long"], store);
    const titles = Object.fromEntries((await store.list()).map((record) => [record.sessionId, record.title]));
    expect(titles).toEqual({ ses_default: "Rename the module", ses_none: "y".repeat(100), ses_long: "z".repeat(100) });
  });

  it("imports a session that ran nothing as a zero total and no model", async () => {
    const { server, api, store } = await setup(generation);
    server.seed({ id: "ses_plain", directory: "/w", title: "Plain", updated: 11, entries: [{ user: "hello" }, { assistant: "hi" }] });
    await importOpenCodeSessions(api, ["ses_plain"], store);
    const [record] = await store.list();
    expect(record!.updatedAt).toBe(11);
    expect(record!.observedModel).toBeUndefined();
    expect(record!.usage).toMatchObject({ totalTokens: 0, costUsd: 0, turns: 1 });
  });

  it("keeps a long conversation's first user message and its newest 199 messages", async () => {
    const { server, api, store } = await setup(generation);
    const entries: Entry[] = Array.from({ length: 250 }, (_, index) => index % 2 === 0 ? { user: `question ${index}` } : { assistant: `answer ${index}` });
    server.seed({ id: "ses_long", directory: "/w", title: "Long", updated: 5, entries });
    await importOpenCodeSessions(api, ["ses_long"], store);
    const [record] = await store.list();
    expect(record!.messages).toHaveLength(200);
    expect(record!.messages[0]).toMatchObject({ role: "user", text: "question 0" });
    expect(record!.messages[1]!.text).toBe("answer 51");
    expect(record!.messages.at(-1)!.text).toBe("answer 249");
  });

  // 850 messages are more than the four pages OpenCode 2 reads, so its first message is fetched apart;
  // the pages after the first carry no limit, though, and the second one looks like the last.
  (generation.cursorKeepsPageSize ? it : it.fails)("finds the first user message of a conversation longer than the pages read", async () => {
    const { server, api, store } = await setup(generation);
    const entries: Entry[] = Array.from({ length: 850 }, (_, index) => index % 2 === 0 ? { user: `question ${index}` } : { assistant: `answer ${index}` });
    server.seed({ id: "ses_huge", directory: "/w", title: "Huge", updated: 5, entries });
    await importOpenCodeSessions(api, ["ses_huge"], store);
    const [record] = await store.list();
    expect(record!.messages).toHaveLength(200);
    expect(record!.messages[0]).toMatchObject({ role: "user", text: "question 0" });
    expect(record!.messages[1]!.text).toBe("answer 651");
    expect(record!.messages.at(-1)!.text).toBe("answer 849");
  });

  it("refuses what is no session of OpenCode, and a session with nothing to resume, and imports the rest", async () => {
    const { server, api, store } = await setup(generation);
    server.seed({ id: "ses_ok", directory: "/w", title: "Fine", updated: 3, entries: [{ user: "hi" }, { assistant: "yo" }] });
    server.seed({ id: "ses_empty", directory: "/w", title: "Empty", updated: 2 });
    server.seed({ id: "ses_tools", directory: "/w", title: "Tools only", updated: 1, entries: [{ synthetic: "added" }, { tool: true }] });
    const outcome = await importOpenCodeSessions(api, ["ses_ok", "ses_missing", 42, "ses_empty", "ses_tools"], store);
    expect(outcome.imported).toHaveLength(1);
    expect(outcome.skipped).toBe(0);
    expect(outcome.failed).toEqual([
      { path: "42", reason: "not a session of OpenCode" },
      { path: "ses_missing", reason: "not a session of OpenCode" },
      { path: "ses_empty", reason: "no conversation to resume" },
      { path: "ses_tools", reason: "no conversation to resume" },
    ]);
    expect((await store.list()).map((record) => record.sessionId)).toEqual(["ses_ok"]);
  });

  it("asks nothing for an empty or malformed list, and skips a session already imported", async () => {
    const { server, api, store } = await setup(generation);
    server.seed({ id: "ses_a", directory: "/w", title: "A", updated: 3, entries: [{ user: "hi" }] });
    expect(await importOpenCodeSessions(api, undefined, store)).toEqual({ imported: [], skipped: 0, failed: [] });
    expect(await importOpenCodeSessions(api, "ses_a", store)).toEqual({ imported: [], skipped: 0, failed: [] });
    expect(await importOpenCodeSessions(api, [], store)).toEqual({ imported: [], skipped: 0, failed: [] });
    expect((await importOpenCodeSessions(api, ["ses_a"], store)).imported).toHaveLength(1);
    expect(await importOpenCodeSessions(api, ["ses_a"], store)).toEqual({ imported: [], skipped: 1, failed: [] });
    // A session named twice in one request is imported once.
    server.seed({ id: "ses_b", directory: "/w", title: "B", updated: 4, entries: [{ user: "hi" }] });
    const twice = await importOpenCodeSessions(api, ["ses_b", "ses_b"], store);
    expect(twice.imported).toHaveLength(1);
    expect(twice.skipped).toBe(1);
  });

  it("reports a conversation the server cannot read as that session's failure, not the whole import's", async () => {
    const { server, api, store } = await setup(generation);
    server.seed({ id: "ses_ok", directory: "/w", title: "Fine", updated: 3, entries: [{ user: "hi" }] });
    server.seed({ id: "ses_broken", directory: "/w", title: "Broken", updated: 2, entries: [{ user: "hi" }] });
    const flaky = Object.assign(Object.create(api) as OpenCodeApi, {
      historyMessages: (directory: string, id: string) => id === "ses_broken" ? Promise.reject(new Error("the server lost it")) : api.historyMessages(directory, id),
    });
    const outcome = await importOpenCodeSessions(flaky, ["ses_broken", "ses_ok"], store);
    expect(outcome.failed).toEqual([{ path: "ses_broken", reason: "the server lost it" }]);
    expect(outcome.imported).toHaveLength(1);
  });
});

describe("boundedMessages", () => {
  const message = (role: "user" | "assistant", text: string, timestamp: number) => ({ role, text, timestamp });

  it("keeps a short conversation whole, with the model", () => {
    const messages = [message("user", "a", 1), message("assistant", "b", 2)];
    expect(boundedMessages({ messages, model: { provider: "p", id: "m" } })).toEqual({ messages, model: { provider: "p", id: "m" } });
    expect(boundedMessages({ messages })).toEqual({ messages });
  });

  it("keeps exactly 200 messages whole, and cuts 201 to the first user message and the newest 199", () => {
    const build = (count: number) => Array.from({ length: count }, (_, index) => message(index === 0 ? "assistant" : index % 2 === 1 ? "user" : "assistant", `m${index}`, index));
    expect(boundedMessages({ messages: build(200) }).messages).toHaveLength(200);
    const cut = boundedMessages({ messages: build(201) }).messages;
    expect(cut).toHaveLength(200);
    // The first message is the assistant's; the first user message leads, then the newest 199.
    expect(cut[0]!.text).toBe("m1");
    expect(cut[1]!.text).toBe("m2");
    expect(cut.at(-1)!.text).toBe("m200");
  });

  it("leaves a long conversation without a user message whole; an import refuses it anyway", () => {
    const messages = Array.from({ length: 250 }, (_, index) => message("assistant", `m${index}`, index));
    expect(boundedMessages({ messages }).messages).toHaveLength(250);
  });
});
