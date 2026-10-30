import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAgent, type FakeAgent } from "./fake.js";
import { AcpReplay, importAcpSessions, importHome, listAcpSessions, scanAcpSessions, type OpenImportSession } from "./history-import.js";
import { AcpAgentSession } from "./session.js";
import { AcpSessionStore } from "./session-store.js";

const directories: string[] = [];
const stores: AcpSessionStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((entry) => entry.dispose()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function store(): Promise<AcpSessionStore> {
  const directory = await mkdtemp(join(tmpdir(), "tau-acp-import-"));
  directories.push(directory);
  const made = new AcpSessionStore({ filePath: join(directory, "tau", "fake-runtime-sessions.json"), backendKind: "fake", agent: "Fake" });
  stores.push(made);
  return made;
}

const CAPABLE = { loadSession: true, sessionCapabilities: { list: {} } };
const chunk = (sessionId: string, sessionUpdate: string, text: string) => ({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate, content: { type: "text", text } } } });

/** An agent over synthetic sessions: `listed` answers `session/list`, `replays` what each `session/load` sends first. */
function agentWith(options: { capabilities?: object; listed?: unknown[] | ((params: { cursor?: string }) => unknown); replays?: Record<string, Array<[string, string]>> } = {}) {
  const agents: FakeAgent[] = [];
  const opened: AcpAgentSession[] = [];
  const open: OpenImportSession = async (onUpdate) => {
    const agent = fakeAgent();
    agents.push(agent);
    agent.respond("initialize", () => ({ protocolVersion: 1, agentInfo: { name: "fake", version: "1.2.3" }, agentCapabilities: options.capabilities ?? CAPABLE }));
    agent.respond("session/list", (params) => typeof options.listed === "function" ? options.listed((params ?? {}) as { cursor?: string }) : { sessions: options.listed ?? [] });
    agent.respond("session/load", (params) => {
      const { sessionId } = params as { sessionId: string };
      const replay = options.replays?.[sessionId];
      if (!replay) return { error: { code: -32002, message: `Session not found: ${sessionId}` } };
      for (const [kind, text] of replay) agent.send(kind === "tool" ? { jsonrpc: "2.0", method: "session/update", params: { sessionId, update: { sessionUpdate: "tool_call", toolCallId: "t", title: "Read" } } } : chunk(sessionId, kind, text));
      return {};
    });
    const session = new AcpAgentSession({ agentName: "Fake", process: agent.process, cwd: "/state", clientInfo: { name: "tau", version: "1" }, clientCapabilities: {}, onUpdate, onPermission: async () => ({ outcome: { outcome: "cancelled" } }) });
    await session.initialize();
    opened.push(session);
    return session;
  };
  return { open, agents, opened };
}

describe("ACP history import", () => {
  it("names a fixture home per backend kind only when a fixture root is set", () => {
    expect(importHome({ TAU_IMPORT_ROOTS: "/fixtures" }, "cursor")).toBe(join("/fixtures", "cursor"));
    expect(importHome({}, "cursor")).toBeUndefined();
  });

  it("lists sessions newest first across pages, leaving out entries without an id or an absolute folder", async () => {
    const pages: Record<string, unknown> = {
      "": { sessions: [{ sessionId: "s-old", cwd: "/work/a", title: "Old", updatedAt: "2026-01-01T00:00:00Z" }, { sessionId: "s-rel", cwd: "work/b" }, { cwd: "/work/c" }, "junk"], nextCursor: "p2" },
      p2: { sessions: [{ sessionId: "s-new", cwd: "/work/b", updatedAt: "2026-02-01T00:00:00Z" }, { sessionId: "s-old", cwd: "/work/a" }] },
    };
    const { open } = agentWith({ listed: (params) => pages[params.cursor ?? ""] });
    const session = await open(() => undefined);
    try {
      const listed = await listAcpSessions(session);
      expect(listed.truncated).toBe(false);
      expect(listed.sessions.map((entry) => [entry.sessionId, entry.cwd, entry.title])).toEqual([["s-new", "/work/b", undefined], ["s-old", "/work/a", "Old"]]);
    } finally { await session.close(); }
  });

  it("marks a list cut off by its cap as truncated", async () => {
    const { open } = agentWith({ listed: Array.from({ length: 4 }, (_, index) => ({ sessionId: `s-${index}`, cwd: "/work", updatedAt: index })) });
    const session = await open(() => undefined);
    try {
      const listed = await listAcpSessions(session, 3);
      expect(listed.sessions).toHaveLength(3);
      expect(listed.truncated).toBe(true);
    } finally { await session.close(); }
  });

  it("scans what the agent lists and marks the sessions Tau already holds", async () => {
    const { open, opened } = agentWith({ listed: [{ sessionId: "s-1", cwd: "/work/a", title: "Fix the build", updatedAt: "2026-03-01T10:00:00Z" }, { sessionId: "s-2", cwd: "/work/a" }] });
    const scan = await scanAcpSessions(open, (id) => id === "s-2", "Fake");
    expect(scan).toEqual({
      truncated: false,
      sessions: [
        { path: "s-1", sessionId: "s-1", cwd: "/work/a", title: "Fix the build", updatedAt: Date.parse("2026-03-01T10:00:00Z"), imported: false },
        { path: "s-2", sessionId: "s-2", cwd: "/work/a", title: "Untitled conversation", updatedAt: 0, imported: true },
      ],
    });
    expect(opened[0]!.closed).toBe(true);
  });

  it("says why an agent that lists no sessions, or replays none, cannot be imported", async () => {
    const unlisted = agentWith({ capabilities: { loadSession: true } });
    await expect(scanAcpSessions(unlisted.open, () => false, "Fake")).resolves.toEqual({ sessions: [], truncated: false, unsupported: "Fake 1.2.3 does not list its sessions to other apps, so Tau cannot find them." });
    expect(unlisted.agents[0]!.received.some((message) => message.method === "session/list")).toBe(false);
    const unloadable = agentWith({ capabilities: { sessionCapabilities: { list: {} } } });
    await expect(scanAcpSessions(unloadable.open, () => false, "Fake")).resolves.toMatchObject({ unsupported: expect.stringContaining("does not replay a session") });
  });

  it("joins a replay's chunks into messages, a tool call between agent text keeping it apart", () => {
    const replay = new AcpReplay();
    const send = (sessionUpdate: string, text = "") => replay.onUpdate({ sessionUpdate, content: { type: "text", text } });
    send("user_message_chunk", "Fix ");
    send("user_message_chunk", "the build");
    send("agent_thought_chunk", "thinking");
    send("agent_message_chunk", "Looking.");
    send("tool_call");
    send("agent_message_chunk", "Fixed it.");
    send("user_message_chunk", "Thanks");
    expect(replay.take(5)).toEqual([
      { role: "user", text: "Fix the build", timestamp: 5 },
      { role: "assistant", text: "Looking.\n\nFixed it.", timestamp: 5 },
      { role: "user", text: "Thanks", timestamp: 5 },
    ]);
    expect(replay.take(5)).toEqual([]);
  });

  it("imports each session's replay as a thread that loads the session, and skips what Tau holds", async () => {
    const target = await store();
    const listed = [
      { sessionId: "s-1", cwd: "/work/a", title: "Fix the build", updatedAt: "2026-03-01T10:00:00Z" },
      { sessionId: "s-2", cwd: "/work/b", updatedAt: "2026-03-02T10:00:00Z" },
      { sessionId: "s-empty", cwd: "/work/b" },
      { sessionId: "s-gone", cwd: "/work/b" },
    ];
    const replays: Record<string, Array<[string, string]>> = {
      "s-1": [["user_message_chunk", "Fix the build"], ["agent_message_chunk", "Done."]],
      "s-2": [["user_message_chunk", "Rename the module\nplease"], ["agent_message_chunk", "Renamed."]],
      "s-empty": [["agent_message_chunk", "Hello"]],
    };
    const { open, agents } = agentWith({ listed, replays });
    const outcome = await importAcpSessions(open, ["s-1", "s-2", "s-empty", "s-gone", "s-unknown", 42], target, "Fake");
    expect(outcome.imported).toHaveLength(2);
    expect(outcome.skipped).toBe(0);
    expect(outcome.failed).toEqual([
      { path: "42", reason: "not a session of Fake" },
      { path: "s-empty", reason: "no conversation to resume" },
      { path: "s-gone", reason: "Session not found: s-gone" },
      { path: "s-unknown", reason: "not a session of Fake" },
    ]);
    // One process for the whole batch; each load in the session's own folder, without Tau's tools.
    expect(agents).toHaveLength(1);
    expect(agents[0]!.received.filter((message) => message.method === "session/load").map((message) => message.params)).toEqual([
      { sessionId: "s-1", cwd: "/work/a", mcpServers: [] },
      { sessionId: "s-2", cwd: "/work/b", mcpServers: [] },
      { sessionId: "s-empty", cwd: "/work/b", mcpServers: [] },
      { sessionId: "s-gone", cwd: "/work/b", mcpServers: [] },
    ]);
    const threads = await target.list();
    expect(threads.map((thread) => [thread.acpSessionId, thread.cwd, thread.title, thread.messages.map((message) => `${message.role}:${message.text}`)]).sort()).toEqual([
      ["s-1", "/work/a", "Fix the build", ["user:Fix the build", "assistant:Done."]],
      ["s-2", "/work/b", "Rename the module", ["user:Rename the module\nplease", "assistant:Renamed."]],
    ]);
    expect(threads.find((thread) => thread.acpSessionId === "s-1")!.updatedAt).toBe(Date.parse("2026-03-01T10:00:00Z"));

    // Again: Tau holds both, so nothing is loaded and no agent starts.
    const again = agentWith({ listed, replays });
    await expect(importAcpSessions(again.open, ["s-1", "s-2"], target, "Fake")).resolves.toEqual({ imported: [], skipped: 2, failed: [] });
    expect(again.agents).toHaveLength(0);
  });

  it("refuses the whole batch when the agent cannot list its sessions", async () => {
    const target = await store();
    const { open } = agentWith({ capabilities: { loadSession: true } });
    await expect(importAcpSessions(open, ["s-1"], target, "Fake")).rejects.toThrow("does not list its sessions");
    expect(await target.list()).toEqual([]);
  });
});

describe("AcpSessionStore.adopt", () => {
  it("keeps one thread per agent session and refuses entries without a session or folder", async () => {
    const target = await store();
    const message = { role: "user" as const, text: "Hi", timestamp: 3 };
    const first = await target.adopt([
      { acpSessionId: "s-1", cwd: "/work", title: "  Hi  ", messages: [message], updatedAt: 9 },
      { acpSessionId: "s-1", cwd: "/work", title: "Twice", messages: [message], updatedAt: 9 },
      { acpSessionId: "", cwd: "/work", title: "No id", messages: [message], updatedAt: 9 },
    ]);
    expect(first.map(Boolean)).toEqual([true, false, false]);
    expect(await target.get(first[0]!)).toMatchObject({ backendKind: "fake", acpSessionId: "s-1", cwd: "/work", title: "Hi", titleSource: "derived", createdAt: 3, updatedAt: 9 });
    expect(await target.adopt([{ acpSessionId: "s-1", cwd: "/work", title: "Hi", messages: [message], updatedAt: 9 }])).toEqual([undefined]);
    expect(await target.acpSessionIds()).toEqual(new Set(["s-1"]));
  });
});
