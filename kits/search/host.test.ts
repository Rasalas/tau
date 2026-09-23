import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { threadTextsDelta, THREAD_TEXTS_COMMAND, type HostExtension, type HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import createSearchHostExtension from "./host.js";
import { SEARCH_KIT_ID, type ContentSearchResult, type FileSearchResult, type ThreadMatch } from "./protocol.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

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

async function harness(cwd: string, ripgrep: string | undefined, extra: Partial<HostExtensionServices> = {}) {
  const spawned: string[] = [];
  const registry = await activateHostKit(createSearchHostExtension() as unknown as HostExtension, {
    cwd: () => cwd,
    findCommand: (name: string) => name === "rg" ? ripgrep : undefined,
    noteSubprocess: () => { spawned.push("rg"); },
    ...extra,
  } as Partial<HostExtensionServices>);
  const invoke = <T>(command: string, input: unknown) => registry.invoke(SEARCH_KIT_ID, command, input) as Promise<T>;
  return { invoke, spawned };
}

const PROJECT = {
  ".gitignore": "ignored/\n",
  "src/a.ts": "export const needle = 1;\n",
  "src/b.ts": "// Needle again\n",
  "ignored/c.ts": "needle",
};

describe("Search host: content", () => {
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

describe("Search host: threads", () => {
  const message = (role: string, text: string) => JSON.stringify({ type: "message", message: { role, content: [{ type: "text", text }, { type: "thinking", thinking: "hidden luna" }] } });

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
      findCommand: () => undefined,
      sessions: { list: async () => [{ sessionId: "pi", cwd: root, path: piPath }] } as never,
    } as Partial<HostExtensionServices>);
    await registry.activate(codex);
    const found = await registry.invoke(SEARCH_KIT_ID, "threads", { query: "luna" }) as ThreadMatch[];
    expect(found.map((match) => [match.sessionId, match.path])).toEqual([["codex-new", ""], ["pi", piPath], ["codex-old", ""]]);
    expect(found[0]).toMatchObject({ role: "user", snippet: "plan the luna launch" });
    expect(asked).toEqual([{ known: {}, limit: 25 }]);
    // The next keystrokes search the index as it is; the kit is asked again only after a few seconds.
    expect((await registry.invoke(SEARCH_KIT_ID, "threads", { query: "older" }) as ThreadMatch[]).map((match) => match.sessionId)).toEqual(["codex-old"]);
    expect(asked).toHaveLength(1);
  });
});
