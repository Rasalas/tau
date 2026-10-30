import { execFileSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { threadTextsDelta, THREAD_TEXTS_COMMAND, type HostConversationServices, type HostExtension, type HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createSearchHostExtension from "./host.js";
import { SEARCH_KIT_ID, type ContentSearchResult, type FileSearchResult, type ThreadFindResult, type ThreadMatch, type ThreadRequestMatch } from "./protocol.js";
import { THREAD_TEXT_LIMIT } from "./threads.js";

vi.mock("node:fs/promises", async (original) => {
  const originalFs = await original<typeof import("node:fs/promises")>();
  return { ...originalFs, stat: vi.fn(originalFs.stat) };
});
const roots: string[] = [];
vi.mock("node:os", async (original) => {
  const os = await original<typeof import("node:os")>();
  return { ...os, homedir: vi.fn(os.homedir) };
});
afterEach(async () => { vi.mocked(homedir).mockReset(); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function folder(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-search-host-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
  return root;
}

function installedRipgrep(): string | undefined {
  try { return execFileSync("/bin/sh", ["-c", "command -v rg"], { encoding: "utf8" }).trim() || undefined; } catch { return undefined; }
}

/** Stands in for ripgrep: one match, then it waits to be stopped when the query says "slow". */
async function fakeRipgrep(): Promise<string> {
  const root = await folder({});
  const path = join(root, "rg");
  await writeFile(path, [
    "#!/bin/sh",
    'case "$*" in *--files*) printf \'./b.ts\\n./a.ts\\n\'; exit 0;; esac',
    'case "$*" in *"("*) echo "rg: regex parse error:" >&2; echo "error: unclosed group" >&2; exit 2;; esac',
    'printf \'{"type":"match","data":{"path":{"text":"./a.ts"},"lines":{"text":"const needle = 1;\\\\n"},"line_number":3,"submatches":[{"start":6,"end":12}]}}\\n\'',
    'case "$*" in *slow*) exec sleep 30;; esac',
    "exit 0",
  ].join("\n"));
  await chmod(path, 0o755);
  return path;
}

async function harness(cwd: string, ripgrep: string | undefined, extra: Partial<HostExtensionServices> = {}, options: { now?(): number } = {}) {
  const spawned: string[] = [];
  const registry = await activateHostKit(createSearchHostExtension(options) as unknown as HostExtension, {
    cwd: () => cwd,
    stateDir: join(cwd, "state"),
    findCommand: (name: string) => name === "rg" ? ripgrep : undefined,
    noteSubprocess: () => { spawned.push("rg"); },
    ...extra,
  } as Partial<HostExtensionServices>);
  const invoke = <T>(command: string, input: unknown) => registry.invoke(SEARCH_KIT_ID, command, input) as Promise<T>;
  return { registry, invoke, spawned };
}

const PROJECT = {
  ".gitignore": "ignored/\n",
  "src/a.ts": "export const needle = 1;\n",
  "src/b.ts": "// Needle again\n",
  "ignored/c.ts": "needle",
};

describe("Search host: content", () => {
  for (const engine of ["walker", "ripgrep"] as const) {
    it.skipIf(engine === "ripgrep" && !installedRipgrep())(`searches project dotfiles but never home secrets or Git internals for a device (${engine})`, async () => {
      const root = await folder({ "home/.tau/host-token": "fixture-token", "home/.other-secret": "fixture-token", "home/.gitignore": "repo/\n", "home/repo/.github/workflows/ci.yml": "fixture-token", "home/repo/.tau/project.json": "project-setting", "home/repo/.git/config": "fixture-token", "home/repo/visible.txt": "visible /etc/passwd" });
      const home = join(root, "home");
      vi.mocked(homedir).mockReturnValue(home);
      const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
      for (const cwd of [join(home, "repo"), home, root]) {
        const prefix = cwd === root ? "home/repo/" : cwd === home ? "repo/" : "";
        const { registry, invoke } = await harness(cwd, engine === "ripgrep" ? installedRipgrep() : undefined, {}, { now: () => 0 });
        try {
          expect(await registry.invoke(SEARCH_KIT_ID, "content", { query: "fixture-token" }, phone)).toMatchObject({ engine: cwd === join(home, "repo") ? engine : "walker", matches: [{ path: prefix + ".github/workflows/ci.yml" }] });
          expect(await registry.invoke(SEARCH_KIT_ID, "files", { query: "ci.yml" }, phone)).toMatchObject({ files: [{ path: prefix + ".github/workflows/ci.yml" }] });
          expect(await registry.invoke(SEARCH_KIT_ID, "content", { query: "project-setting" }, phone)).toMatchObject({ matches: [{ path: prefix + ".tau/project.json" }] });
          expect(await registry.invoke(SEARCH_KIT_ID, "content", { query: "/etc/passwd" }, phone)).toMatchObject({ matches: [{ path: prefix + "visible.txt" }] });
          if (cwd === home) expect((await invoke<ContentSearchResult>("content", { query: "fixture-token" })).matches).toEqual(expect.arrayContaining([expect.objectContaining({ path: ".tau/host-token", text: "fixture-token" })]));
        } finally {
          await registry.deactivate(SEARCH_KIT_ID);
        }
      }
    });
  }

  it("rechecks a cached search file that became a link outside the project", async () => {
    const root = await folder({ "visible.txt": "visible" });
    const outside = await folder({ ".tau/host-token": "fixture-token" });
    const { registry } = await harness(root, undefined, {}, { now: () => 0 });
    const phone = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
    try {
      await registry.invoke(SEARCH_KIT_ID, "files", { query: "visible" }, phone);
      await rm(join(root, "visible.txt"));
      await symlink(join(outside, ".tau/host-token"), join(root, "visible.txt"));
      expect(await registry.invoke(SEARCH_KIT_ID, "content", { query: "fixture-token" }, phone)).toMatchObject({ matches: [] });
    } finally {
      await registry.deactivate(SEARCH_KIT_ID);
    }
  });

  it("stops the running search when the next query arrives on its channel", async () => {
    const { invoke } = await harness(await folder({}), await fakeRipgrep());
    const first = invoke<ContentSearchResult>("content", { query: "slow", channel: "w1" });
    const other = await invoke<ContentSearchResult>("content", { query: "fast", channel: "w2" });
    expect(other.matches).toHaveLength(1);
    const second = await invoke<ContentSearchResult>("content", { query: "fast", channel: "w1" });
    expect(await first).toEqual({ matches: [], truncated: false, engine: "ripgrep", cancelled: true });
    expect(second).toEqual({ engine: "ripgrep", truncated: false, matches: [{ path: "a.ts", line: 3, text: "const needle = 1;", ranges: [[6, 12]] }] });
  });

  it("says why ripgrep refused a regular expression", async () => {
    const { invoke } = await harness(await folder({}), await fakeRipgrep());
    expect(await invoke<ContentSearchResult>("content", { query: "(", regex: true })).toMatchObject({ matches: [], error: "Not a valid regular expression: unclosed group" });
  });

  it.skipIf(!installedRipgrep())("searches a real project with ripgrep, leaving out what .gitignore names", async () => {
    const { invoke, spawned } = await harness(await folder(PROJECT), installedRipgrep());
    const result = await invoke<ContentSearchResult>("content", { query: "needle" });
    expect(result.engine).toBe("ripgrep");
    expect(result.matches.map((match) => match.path).sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect((await invoke<ContentSearchResult>("content", { query: "Needle", caseSensitive: true })).matches.map((match) => match.path)).toEqual(["src/b.ts"]);
    expect((await invoke<ContentSearchResult>("content", { query: "needle", limit: 1 })).truncated).toBe(true);
    expect(spawned.length).toBeGreaterThan(0);
  });

  it("walks the project itself without ripgrep, with the same answers", async () => {
    const { invoke, spawned } = await harness(await folder(PROJECT), undefined);
    const result = await invoke<ContentSearchResult>("content", { query: "needle" });
    expect(result).toMatchObject({ engine: "walker", truncated: false });
    expect(result.matches.map((match) => `${match.path}:${match.line}`)).toEqual(["src/a.ts:1", "src/b.ts:1"]);
    expect(await invoke<ContentSearchResult>("content", { query: "(", regex: true })).toMatchObject({ error: expect.stringContaining("Not a valid regular expression") });
    expect(spawned).toEqual([]);
  });
});

describe("Search host: files", () => {
  it("ranks the project's files for the picker from a cached list, read again once invalidated", async () => {
    const cwd = await folder(PROJECT);
    const { invoke } = await harness(cwd, undefined);
    const first = await invoke<FileSearchResult>("files", { query: "sb" });
    expect(first.total).toBe(3);
    expect(first.files[0]).toEqual({ path: "src/b.ts", positions: [0, 4] });
    await writeFile(join(cwd, "src/sb-new.ts"), "");
    expect((await invoke<FileSearchResult>("files", { query: "sbnew" })).files).toEqual([]);
    await invoke("invalidate", { cwd });
    expect((await invoke<FileSearchResult>("files", { query: "sbnew" })).files.map((file) => file.path)).toEqual(["src/sb-new.ts"]);
  });

  it("lists what ripgrep lists, relative to the project", async () => {
    const { invoke } = await harness(await folder({}), await fakeRipgrep());
    expect((await invoke<FileSearchResult>("files", { query: "" })).files.map((file) => file.path)).toEqual(["a.ts", "b.ts"]);
  });
});

describe("Search host: find in a thread", () => {
  it("resolves all-words using global text ranking and keeps omitted or unknown modes literal", async () => {
    const transcript = vi.fn(async (_sessionId?: string) => [
      { id: "old-substring", role: "user", text: "quartzite moonlight", timestamp: 1 },
      { id: "best", role: "assistant", text: "Quartz next to the moon", timestamp: 2 },
      { id: "later", role: "assistant", text: "the moon has quartz", timestamp: 3 },
      { id: "reasoning", role: "assistant", text: "", thinking: "quartz moon", timestamp: 4 },
    ]);
    const { invoke } = await harness(await folder({}), undefined, { transcript } as Partial<HostExtensionServices>);
    expect(await invoke<ThreadFindResult>("find-in-thread", { sessionId: "target", query: "quartz moon", mode: "all-words" })).toEqual({ messageIds: ["best"], truncated: false });
    for (const mode of [undefined, "literal", "unknown"]) {
      expect(await invoke<ThreadFindResult>("find-in-thread", { sessionId: "target", query: "quartz moon", mode })).toEqual({ messageIds: ["reasoning"], truncated: false });
    }
    expect(transcript.mock.calls.every(call => call[0] === "target")).toBe(true);
  });

  const transcript = [
    { id: "u1", role: "user", text: "Which moon has the Quartz vein?", timestamp: 1 },
    { id: "a1", role: "assistant", text: "Nothing here.", thinking: "the quartz idea", timestamp: 2 },
    { id: "n1", role: "notice", text: "quartz in a notice", timestamp: 3 },
    { id: "a2", role: "assistant", text: "Quartz again, with <proposed_plan>\nmine quartz\n</proposed_plan>", timestamp: 4 },
  ];

  it("names the messages of the whole thread that hold the query, oldest first, with their ids", async () => {
    const asked: Array<string | undefined> = [];
    const { invoke } = await harness(await folder({}), undefined, {
      transcript: async (sessionId?: string) => { asked.push(sessionId); return transcript; },
    } as Partial<HostExtensionServices>);
    expect(await invoke<ThreadFindResult>("find-in-thread", { sessionId: "t1", query: "  QUARTZ " })).toEqual({ messageIds: ["u1", "a1", "a2"], truncated: false });
    expect(asked).toEqual(["t1"]);
    expect(await invoke<ThreadFindResult>("find-in-thread", { sessionId: "t1", query: "absent" })).toEqual({ messageIds: [], truncated: false });
    expect(await invoke<ThreadFindResult>("find-in-thread", { sessionId: "t1", query: "  " })).toEqual({ messageIds: [], truncated: false });
    expect(asked).toEqual(["t1", "t1"]);
  });

  it("propagates transcript failures instead of claiming zero matches", async () => {
    const { invoke } = await harness(await folder({}), undefined, {
      transcript: async () => { throw new Error("no such thread"); },
    } as Partial<HostExtensionServices>);
    await expect(invoke<ThreadFindResult>("find-in-thread", { sessionId: "gone", query: "quartz" })).rejects.toThrow("no such thread");
  });
});

describe("Search host: threads", () => {
  const message = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }, { type: "thinking", thinking: "hidden luna" }] } });

  it("searches a switched Pi conversation's complete history, replaces aliases, and retains external-current sources", async () => {
    const root = await folder({ "original.jsonl": message("user", "source nebula") });
    const originalPath = join(root, "original.jsonl"); const latestPath = join(root, "runtime-segments", "latest.jsonl");
    let currentPi = true;
    let deleted = false;
    const page = vi.fn<HostConversationServices["page"]>(async (sessionId, version) => version !== "canonical-v1" ? { status: "changed" } : {
      status: "ok", page: { sessionId, hasMore: false, messages: [
        { id: "imported", role: "user", text: "imported galaxy", timestamp: 1 },
        { id: "latest", role: "assistant", text: "x".repeat(100_000) + " latest quasar", timestamp: 2 },
      ] },
    });
    const conversations: HostConversationServices = {
      list: async () => currentPi || deleted ? [{ sessionId: "same-id", cwd: root, path: latestPath, modifiedAt: 10, version: "canonical-v1", ...(deleted ? { deleted: true as const } : {}) }] : [],
      page,
    };
    const services = { sessions: { list: async () => [{ sessionId: "same-id", cwd: root, path: originalPath }] } as never, conversations };
    const first = await harness(root, undefined, services, { now: () => 0 });
    await first.registry.activate({ id: "tau.codex", name: "Codex", activate(context) {
      context.registerCommand(THREAD_TEXTS_COMMAND, input => threadTextsDelta([{ tauThreadId: "same-id", updatedAt: 1, messages: [{ role: "assistant", text: "provider comet" }] }], input), { callers: [SEARCH_KIT_ID] });
    } });
    try {
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "galaxy" })).toMatchObject([{ sessionId: "same-id", path: latestPath }]);
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "quasar" })).toMatchObject([{ sessionId: "same-id", path: latestPath }]);
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "comet" })).toEqual([]);
      currentPi = false;
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "nebula" })).toMatchObject([{ sessionId: "same-id", path: originalPath }]);
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "comet" })).toMatchObject([{ sessionId: "same-id" }]);
      deleted = true;
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "nebula" })).toEqual([]);
      expect(await first.invoke<ThreadMatch[]>("threads", { query: "comet" })).toEqual([]);
    } finally { await first.registry.dispose(); }
  });

  it("finds a thread by what was said in it, newest first, and the thread on screen through its runtime", async () => {
    const root = await folder({
      "sessions/old.jsonl": [JSON.stringify({ type: "session" }), message("user", "Which moon?"), message("assistant", "The answer is Luna, the Moon.")].join("\n"),
      "sessions/new.jsonl": [message("user", "Tell me about luna missions please")].join("\n"),
      "sessions/other.jsonl": [message("user", "nothing here"), '{"type":"message","message":{"role":"assistant"'].join("\n"),
    });
    const listed = ["old", "new", "other"].map((id) => ({ sessionId: id, cwd: root, path: join(root, "sessions", `${id}.jsonl`) }));
    const { utimes } = await import("node:fs/promises");
    await utimes(listed[0]!.path, 1, 1);
    const { invoke } = await harness(root, undefined, {
      sessions: { list: async () => listed } as never,
      transcript: async () => [{ id: "m", role: "assistant", text: "Luna from another runtime", timestamp: 1 }],
    } as Partial<HostExtensionServices>);
    const found = await invoke<ThreadMatch[]>("threads", { query: "LUNA" });
    expect(found.map((match) => match.sessionId)).toEqual(["new", "old"]);
    expect(found[1]).toMatchObject({ role: "assistant", snippet: "The answer is Luna, the Moon." });
    expect(await invoke<ThreadMatch[]>("threads", { query: "hidden" })).toEqual([]);
    expect((await invoke<ThreadMatch[]>("threads", { query: "luna", activeSessionId: "claude-1" }))[0]).toMatchObject({ sessionId: "claude-1", path: "" });
    expect(await invoke<ThreadMatch[]>("threads", { query: "  " })).toEqual([]);
  });

  it("finds a closed thread of another runtime through its kit's store, merged with Pi's by recency", async () => {
    const root = await folder({ "sessions/pi.jsonl": message("user", "a luna question on Pi") });
    const piPath = join(root, "sessions", "pi.jsonl");
    const { utimes } = await import("node:fs/promises");
    await utimes(piPath, 2, 2);
    const stored = [
      { tauThreadId: "codex-new", updatedAt: 3_000, messages: [{ role: "user", text: "plan the luna launch" }, { role: "assistant", text: "Luna first." }] },
      { tauThreadId: "codex-old", updatedAt: 1_000, messages: [{ role: "assistant", text: "luna again, older" }] },
    ];
    const asked: unknown[] = [];
    const codex: HostExtension = {
      id: "tau.codex",
      name: "Codex",
      activate(context) {
        context.registerCommand(THREAD_TEXTS_COMMAND, async (input) => { asked.push(input); return threadTextsDelta(stored, input); }, { callers: [SEARCH_KIT_ID] });
      },
    };
    const registry = await activateHostKit(createSearchHostExtension() as unknown as HostExtension, {
      cwd: () => root,
      stateDir: join(root, "state"),
      findCommand: () => undefined,
      sessions: { list: async () => [{ sessionId: "pi", cwd: root, path: piPath }] } as never,
    } as Partial<HostExtensionServices>);
    await registry.activate(codex);
    const found = await registry.invoke(SEARCH_KIT_ID, "threads", { query: "luna" }) as ThreadMatch[];
    expect(found.map((match) => [match.sessionId, match.path])).toEqual([["codex-new", ""], ["pi", piPath], ["codex-old", ""]]);
    expect(found[0]).toMatchObject({ role: "user", snippet: "plan the luna launch" });
    expect(asked[0]).toMatchObject({ protocol: 2, knownVersions: {}, known: {}, limit: 25 });
    expect(asked).toHaveLength(3);
    expect(asked.slice(1)).toEqual(expect.arrayContaining([expect.objectContaining({ page: expect.objectContaining({ threadId: "codex-new" }) }), expect.objectContaining({ page: expect.objectContaining({ threadId: "codex-old" }) })]));
    // The next keystrokes search the index as it is; the kit is asked again only after a few seconds.
    expect((await registry.invoke(SEARCH_KIT_ID, "threads", { query: "older" }) as ThreadMatch[]).map((match) => match.sessionId)).toEqual(["codex-old"]);
    expect(asked).toHaveLength(3);
  });

  it("ranks whole-word content across Pi and runtime threads before recency and the result cap", async () => {
    const root = await folder({
      "sessions/word.jsonl": message("assistant", "Fix auth tokens"),
      "sessions/substring.jsonl": message("user", "oauth redirects"),
    });
    const { utimes } = await import("node:fs/promises");
    const pi = ["word", "substring"].map((id) => ({ sessionId: id, cwd: root, path: join(root, "sessions", `${id}.jsonl`) }));
    await utimes(pi[0]!.path, 1, 1);
    await utimes(pi[1]!.path, 10, 10);
    const codex: HostExtension = {
      id: "tau.codex", name: "Codex", activate(context) {
        context.registerCommand(THREAD_TEXTS_COMMAND, (input) => threadTextsDelta([
          { tauThreadId: "runtime-word", updatedAt: 2_000, messages: [{ role: "user", text: "Review auth tokens" }] },
          { tauThreadId: "runtime-prefix", updatedAt: 20_000, messages: [{ role: "user", text: "Authentication work" }] },
        ], input), { callers: [SEARCH_KIT_ID] });
      },
    };
    const { registry, invoke } = await harness(root, undefined, { sessions: { list: async () => pi } as never });
    await registry.activate(codex);
    expect((await invoke<ThreadMatch[]>("threads", { query: "auth" })).map((entry) => entry.sessionId)).toEqual(["runtime-word", "word", "runtime-prefix", "substring"]);
    expect((await invoke<ThreadMatch[]>("threads", { query: "auth", limit: 1 })).map((entry) => entry.sessionId)).toEqual(["runtime-word"]);
    expect((await invoke<ThreadMatch[]>("threads", { query: "auth", limit: 1, sessionIds: ["word"] })).map((entry) => entry.sessionId)).toEqual(["word"]);
    expect(await invoke<ThreadMatch[]>("threads", { query: "auth", sessionIds: [] })).toEqual([]);
  });

  it("filters delegated and already shown threads out before a palette limit without changing direct search", async () => {
    const root = await folder({
      "sessions/child.jsonl": message("user", "luna"),
      "sessions/title.jsonl": message("user", "luna"),
      "sessions/other.jsonl": message("user", "luna"),
    });
    const pi = ["child", "title", "other"].map((id) => ({ sessionId: id, cwd: root, path: join(root, "sessions", `${id}.jsonl`), ...(id === "child" ? { parentThreadId: "parent" } : {}) }));
    const { utimes } = await import("node:fs/promises");
    await utimes(pi[0]!.path, 30, 30);
    await utimes(pi[1]!.path, 20, 20);
    await utimes(pi[2]!.path, 10, 10);
    const transcript = vi.fn(async () => [{ id: "c1", role: "user", text: "luna", timestamp: 1 }]);
    const { invoke } = await harness(root, undefined, { sessions: { list: async () => pi } as never, transcript } as Partial<HostExtensionServices>);
    expect((await invoke<ThreadMatch[]>("threads", { query: "luna", limit: 1, activeSessionId: "child", sessionIds: ["other"] })).map((entry) => entry.sessionId)).toEqual(["other"]);
    expect(transcript).not.toHaveBeenCalled();
    // Direct callers can still search a child explicitly. The palette owns its visibility policy.
    expect((await invoke<ThreadMatch[]>("threads", { query: "luna", sessionIds: ["child"] })).map((entry) => entry.sessionId)).toEqual(["child"]);
  });

  it("finds recent appended messages beyond the old Pi prefix and refreshes the cached window", async () => {
    const root = await folder({ "sessions/large.jsonl": [
      message("user", "opening nebula"), message("assistant", "x".repeat(THREAD_TEXT_LIMIT * 2)), message("user", "recent quasar"),
    ].join("\n") });
    const path = join(root, "sessions/large.jsonl");
    const { invoke } = await harness(root, undefined, { sessions: { list: async () => [{ sessionId: "large", cwd: root, path }] } as never });
    expect(await invoke<ThreadMatch[]>("threads", { query: "quasar" })).toMatchObject([{ sessionId: "large", path, snippet: "recent quasar" }]);
    expect(await invoke<ThreadMatch[]>("threads", { query: "nebula" })).toMatchObject([{ sessionId: "large", snippet: "opening nebula" }]);
    const { appendFile } = await import("node:fs/promises");
    await appendFile(path, `\n${message("assistant", "latest pulsar")}`);
    expect(await invoke<ThreadMatch[]>("threads", { query: "pulsar" })).toMatchObject([{ sessionId: "large", snippet: "latest pulsar" }]);
  });

  it("searches the full active Pi transcript, including an omitted middle and unsaved streaming text", async () => {
    const text = `opening ${"x".repeat(THREAD_TEXT_LIMIT)} middle beacon ${"x".repeat(THREAD_TEXT_LIMIT)} end`;
    const root = await folder({ "sessions/large.jsonl": message("assistant", text) });
    const path = join(root, "sessions/large.jsonl");
    const transcript = vi.fn(async () => [
      { id: "a1", role: "assistant", text, timestamp: 1 },
      { id: "a2", role: "assistant", text: "new streaming pulsar", timestamp: 2 },
    ]);
    const { invoke } = await harness(root, undefined, {
      sessions: { list: async () => [{ sessionId: "large", cwd: root, path }] } as never, transcript,
    } as Partial<HostExtensionServices>);
    expect(await invoke<ThreadMatch[]>("threads", { query: "middle beacon" })).toMatchObject([{ sessionId: "large", snippet: expect.stringContaining("middle beacon") }]);
    const matches = await invoke<ThreadMatch[]>("threads", { query: "middle beacon", activeSessionId: "large" });
    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({ sessionId: "large", path, snippet: expect.stringContaining("middle beacon") });
    expect(await invoke<ThreadMatch[]>("threads", { query: "pulsar", activeSessionId: "large" })).toMatchObject([{ sessionId: "large", snippet: "new streaming pulsar" }]);
    expect(transcript).toHaveBeenCalledWith("large");
  });

  it.each([false, true])("uses the file cache for an empty transcript only when its runtime is absent: %s", async (runtimeAvailable) => {
    const root = await folder({ "sessions/attached.jsonl": message("assistant", "saved attached beacon") });
    const path = join(root, "sessions/attached.jsonl");
    const { invoke } = await harness(root, undefined, {
      sessions: { list: async () => [{ sessionId: "attached", cwd: root, path }] } as never,
      transcript: async () => [],
      thread: () => runtimeAvailable ? { sessionId: "attached" } as ReturnType<HostExtensionServices["thread"]> : undefined,
    } as Partial<HostExtensionServices>);
    const matches = await invoke<ThreadMatch[]>("threads", { query: "beacon", activeSessionId: "attached" });
    expect(matches).toEqual(runtimeAvailable ? [] : [expect.objectContaining({ sessionId: "attached", path, snippet: "saved attached beacon" })]);
  });

  it("searches an active runtime's full transcript beyond a legacy exported prefix, falling back when unavailable", async () => {
    const full = `opening ${"x".repeat(100_000)} recent quasar`;
    const stored = [{ tauThreadId: "runtime", updatedAt: 1, messages: [{ role: "assistant", text: full }] }];
    const transcript = vi.fn(async () => [{ id: "a1", role: "assistant", text: full, timestamp: 1 }]);
    const { registry, invoke } = await harness(await folder({}), undefined, {
      sessions: { list: async () => [] } as never, transcript,
    } as Partial<HostExtensionServices>);
    await registry.activate({ id: "tau.codex", name: "Codex", activate(context) {
      context.registerCommand(THREAD_TEXTS_COMMAND, (input) => { const { protocol: _protocol, ...legacy } = input as Record<string, unknown>; return threadTextsDelta(stored, legacy); }, { callers: [SEARCH_KIT_ID] });
    } });
    expect(await invoke<ThreadMatch[]>("threads", { query: "quasar" })).toEqual([]);
    expect(await invoke<ThreadMatch[]>("threads", { query: "quasar", activeSessionId: "runtime" })).toMatchObject([{ sessionId: "runtime", snippet: expect.stringContaining("recent quasar") }]);
    transcript.mockRejectedValueOnce(new Error("not open"));
    expect(await invoke<ThreadMatch[]>("threads", { query: "opening", activeSessionId: "runtime" })).toMatchObject([{ sessionId: "runtime", snippet: expect.stringContaining("opening") }]);
  });

  it("considers older and newly added candidates before the result limit, across more than 400 files", async () => {
    const root = await folder(Object.fromEntries(Array.from({ length: 402 }, (_, at) => [`sessions/t${at}.jsonl`, message("user", at === 0 ? "auth tokens" : "unrelated")])));
    const listed = Array.from({ length: 402 }, (_, at) => ({ sessionId: `t${at}`, cwd: root, path: join(root, "sessions", `t${at}.jsonl`) }));
    const { utimes } = await import("node:fs/promises");
    await utimes(listed[0]!.path, 1, 1);
    const { registry, invoke } = await harness(root, undefined, { sessions: { list: async () => listed } as never });
    try {
      expect(await invoke<ThreadMatch[]>("threads", { query: "auth", limit: 1 })).toMatchObject([{ sessionId: "t0" }]);
      const path = join(root, "sessions", "new.jsonl"); await writeFile(path, message("assistant", "auth tokens newest"));
      listed.push({ sessionId: "new", cwd: root, path });
      expect(await invoke<ThreadMatch[]>("threads", { query: "auth", limit: 1 })).toMatchObject([{ sessionId: "new" }]);
      expect(await invoke<ThreadMatch[]>("threads", { query: "auth", limit: 1, sessionIds: ["t0"] })).toMatchObject([{ sessionId: "t0" }]);
    } finally { await registry.deactivate(SEARCH_KIT_ID); }
  }, 30_000);

  it("keeps a restarted host current through edits and deletion, with authoritative active data and file fallback", async () => {
    const root = await folder({ "sessions/t.jsonl": message("assistant", `opening ${"x".repeat(450_000)} middle beacon ${"y".repeat(450_000)} end`) });
    const path = join(root, "sessions", "t.jsonl");
    let listed = [{ sessionId: "t", cwd: root, path }];
    let live = false;
    let liveText = "streaming nova";
    const services = {
      sessions: { list: async () => listed } as never,
      transcript: async () => live ? [{ id: "a", role: "assistant", text: liveText, timestamp: 1 }] : [],
      thread: () => live ? { sessionId: "t" } as ReturnType<HostExtensionServices["thread"]> : undefined,
    } as Partial<HostExtensionServices>;
    const first = await harness(root, undefined, services);
    expect(await first.invoke<ThreadMatch[]>("threads", { query: "middle beacon" })).toMatchObject([{ sessionId: "t" }]);
    await first.registry.deactivate(SEARCH_KIT_ID);
    const restarted = await harness(root, undefined, services);
    try {
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "middle beacon" })).toMatchObject([{ sessionId: "t" }]);
      live = true;
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "middle beacon", activeSessionId: "t" })).toEqual([]);
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "nova", activeSessionId: "t" })).toMatchObject([{ sessionId: "t", snippet: "streaming nova" }]);
      liveText = "streaming pulsar";
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "nova", activeSessionId: "t" })).toEqual([]);
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "pulsar", activeSessionId: "t" })).toMatchObject([{ sessionId: "t" }]);
      live = false;
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "middle beacon", activeSessionId: "t" })).toMatchObject([{ sessionId: "t" }]);
      await writeFile(path, message("user", "replacement comet"));
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "middle beacon" })).toEqual([]);
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "comet" })).toMatchObject([{ sessionId: "t", role: "user" }]);
      await rm(path); listed = [];
      expect(await restarted.invoke<ThreadMatch[]>("threads", { query: "comet" })).toEqual([]);
    } finally { await restarted.registry.deactivate(SEARCH_KIT_ID); }
  });

  it("finds threads through Review Kit's stored request links and answers nothing without it", async () => {
    const asked: unknown[] = [];
    const review: HostExtension = {
      id: "tau.review",
      name: "Review",
      activate(context) {
        context.registerCommand("thread-request-links", (input) => {
          asked.push(input);
          const request = { url: "https://github.com/acme/tau/pull/95", repository: "acme/tau", number: 95, state: "open", title: "Add it", headBranch: "feat/x" };
          return { t1: [request], t2: [request] };
        }, { callers: [SEARCH_KIT_ID] });
      },
    };
    const registry = await activateHostKit(createSearchHostExtension() as unknown as HostExtension, { cwd: () => "/", findCommand: () => undefined } as Partial<HostExtensionServices>);
    expect(await registry.invoke(SEARCH_KIT_ID, "thread-requests", { query: "#95" })).toEqual([]);
    await registry.activate(review);
    const found = await registry.invoke(SEARCH_KIT_ID, "thread-requests", { query: " #95 " }) as ThreadRequestMatch[];
    expect(found).toEqual(["t1", "t2"].map((sessionId) => ({ sessionId, requests: [expect.objectContaining({ number: 95, repository: "acme/tau" })] })));
    expect(asked).toEqual([{ query: "#95" }]);
    expect(await registry.invoke(SEARCH_KIT_ID, "thread-requests", { query: "#95", limit: 1, sessionIds: ["t2"] })).toMatchObject([{ sessionId: "t2" }]);
    expect(await registry.invoke(SEARCH_KIT_ID, "thread-requests", { query: "#95", sessionIds: [] })).toEqual([]);
    expect(await registry.invoke(SEARCH_KIT_ID, "thread-requests", { query: "  " })).toEqual([]);
    expect(asked).toHaveLength(2);
  });
});

describe("message index host control", () => {
  it("returns a resumable cold search with a live hit and cancels a stuck export when switched off", async () => {
    const root = await folder({ "sessions/one.jsonl": JSON.stringify({ type: "message", message: { role: "user", content: "disk beacon" } }) + "\n" });
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    let blocked = false;
    const registry = await activateHostKit({ id: "tau.codex", name: "Runtime", activate(context) {
      context.registerCommand(THREAD_TEXTS_COMMAND, async input => {
        if ((input as { protocol?: number }).protocol === 2) { blocked = true; await gate; return { protocol: 2, catalog: [], removed: [], more: false }; }
        return { threads: [], removed: [], more: false };
      }, { callers: [SEARCH_KIT_ID] });
    } }, {
      cwd: () => root, stateDir: join(root, "state"),
      sessions: { list: async () => [{ sessionId: "one", cwd: root, path: join(root, "sessions/one.jsonl") }] } as never,
      transcript: () => [{ id: "live-message", role: "assistant", text: "live beacon", timestamp: 1 }],
    } as Partial<HostExtensionServices>);
    await registry.activate(createSearchHostExtension() as unknown as HostExtension);
    const invoke = <T,>(command: string, input: unknown) => registry.invoke(SEARCH_KIT_ID, command, input) as Promise<T>;
    try {
      await vi.waitFor(() => expect(blocked).toBe(true));
      const page = await invoke<import("./protocol.js").ThreadSearchPage>("thread-search", { query: "beacon", channel: "cold", sessionIds: ["live", "one"], activeSessionId: "live" });
      expect(page.complete).toBe(false);
      expect(page.continuation).toBeTypeOf("string");
      expect(page.status.state).toBe("indexing");
      expect(page.matches).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: "live", snippet: "live beacon" })]));
      await invoke("thread-search-cancel", { channel: "cold" });
      const off = await invoke<import("./protocol.js").MessageIndexStatus>("index-configure", { enabled: false });
      expect(off).toMatchObject({ enabled: false, state: "disabled", bytes: 0 });
      unblock();
      expect(await invoke("index-status", {})).toMatchObject({ enabled: false, state: "disabled" });
      const device = { kind: "workbench-client", connection: "phone", pairedClient: "device", readOnly: true } as const;
      await expect(registry.invoke(SEARCH_KIT_ID, "index-configure", { enabled: true }, device)).rejects.toThrow();
      expect(await registry.invoke(SEARCH_KIT_ID, "index-status", {}, device)).toMatchObject({ enabled: false });
    } finally { unblock(); await registry.deactivate(SEARCH_KIT_ID); }
  });
});

it("shares bounded session metadata work across concurrent queries and invalidates it", async () => {
  const root = await folder({ "state/tau.search/message-index.json": '{"enabled":false}', "one.jsonl": JSON.stringify({ type: "message", message: { role: "user", content: "needle" } }) });
  const list = vi.fn(async () => Array.from({ length: 40 }, (_, i) => ({ sessionId: String(i), cwd: root, path: join(root, `${i}.jsonl`) })));
  const realStat = (await vi.importActual<typeof fs>("node:fs/promises")).stat;
  let active = 0;
  let peak = 0;
  const stats = vi.spyOn(fs, "stat").mockImplementation(async () => {
    active += 1; peak = Math.max(peak, active);
    try { await new Promise((resolve) => setTimeout(resolve, 1)); return await realStat(join(root, "one.jsonl")); }
    finally { active -= 1; }
  });
  stats.mockClear();
  try {
    const { invoke } = await harness(root, undefined, { sessions: { list } as never });
    await Promise.all([invoke("threads", { query: "needle" }), invoke("threads", { query: "other" })]);
    expect(peak).toBeLessThanOrEqual(8);
    expect(stats).toHaveBeenCalledTimes(40);
    await invoke("threads", { query: "third" });
    expect(stats).toHaveBeenCalledTimes(40);
    await invoke("invalidate", {});
    await invoke("threads", { query: "fourth" });
    expect(stats).toHaveBeenCalledTimes(80);
  } finally { stats.mockRestore(); }
});

it.each([false, true])("reports bounded recent coverage while the committed index searches the full message: indexed %s", async (enabled) => {
  const root = await folder({ "state/tau.search/message-index.json": JSON.stringify({ enabled }), "big.jsonl": JSON.stringify({ type: "message", message: { role: "user", content: "x".repeat(1_000_000) + " tailneedle" } }) });
  const { invoke } = await harness(root, undefined, { sessions: { list: async () => [{ sessionId: "big", path: join(root, "big.jsonl"), cwd: root }] } as never });
  expect(await invoke("threads", { query: "tailneedle", includeStatus: true })).toMatchObject({ matches: enabled ? [expect.objectContaining({ sessionId: "big" })] : [], truncated: !enabled });
  expect(await invoke("threads", { query: "tailneedle" })).toEqual(enabled ? [expect.objectContaining({ sessionId: "big" })] : []);
});

it("cancels only the window's old thread search while metadata work is shared", async () => {
  const root = await folder({ "state/tau.search/message-index.json": '{"enabled":false}', "one.jsonl": JSON.stringify({ type: "message", message: { role: "user", content: "needle" } }) });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const list = vi.fn(async () => { await gate; return [{ sessionId: "one", path: join(root, "one.jsonl"), cwd: root }]; });
  const { invoke } = await harness(root, undefined, { sessions: { list } as never });
  const first = invoke("threads", { query: "needle", channel: "w1", includeStatus: true });
  const other = invoke("threads", { query: "needle", channel: "w2", includeStatus: true });
  await vi.waitFor(() => expect(list).toHaveBeenCalled());
  await invoke("threads", { query: "", channel: "w1" });
  release();
  expect(await first).toMatchObject({ matches: [], cancelled: true });
  expect(await other).toMatchObject({ matches: [{ sessionId: "one" }], truncated: false });
  expect(list).toHaveBeenCalledOnce();
});

it("refreshes session text when a completed turn invalidates the index", async () => {
  const root = await folder({ "one.jsonl": JSON.stringify({ type: "message", message: { role: "user", content: "before" } }) });
  let ended!: () => void;
  const { invoke } = await harness(root, undefined, {
    sessions: { list: async () => [{ sessionId: "one", path: join(root, "one.jsonl"), cwd: root }] } as never,
    registerTurnObserver: (observer) => { ended = () => { void observer.ended?.("one", "turn", "completed"); }; return () => undefined; },
  });
  expect(await invoke("threads", { query: "after" })).toEqual([]);
  await writeFile(join(root, "one.jsonl"), JSON.stringify({ type: "message", message: { role: "user", content: "after the turn" } }));
  ended();
  expect(await invoke("threads", { query: "after" })).toMatchObject([{ sessionId: "one" }]);
});
