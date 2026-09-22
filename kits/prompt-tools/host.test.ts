import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension } from "tau/host-extension";
import { activateHostKit, type PublishedKitEvent } from "../../src/main/test-support/host-kit-harness.js";
import createPromptToolsHostExtension from "./host.js";
import { MAX_STASH_ENTRIES, PROMPT_TOOLS_ID, type StashEntry } from "./protocol.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

function userLine(text: string, at: number): string {
  return JSON.stringify({ type: "message", id: `m${at}`, parentId: null, timestamp: new Date(at).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: at } });
}

async function harness(sessions: Array<{ sessionId: string; cwd: string; prompts: Array<[string, number]>; modified: number }> = []) {
  const root = await mkdtemp(join(tmpdir(), "tau-prompt-tools-"));
  directories.push(root);
  const listed: Array<{ sessionId: string; cwd: string; path: string }> = [];
  for (const session of sessions) {
    const path = join(root, "sessions", `${session.sessionId}.jsonl`);
    await mkdir(join(root, "sessions"), { recursive: true });
    const lines = [JSON.stringify({ type: "session", id: session.sessionId, cwd: session.cwd }), ...session.prompts.map(([text, at]) => userLine(text, at)), '{"type":"message","message":{"role":"user"'];
    await writeFile(path, `${lines.join("\n")}\n`);
    await utimes(path, session.modified / 1000, session.modified / 1000);
    listed.push({ sessionId: session.sessionId, cwd: session.cwd, path });
  }
  let clock = 1_000;
  const events: PublishedKitEvent[] = [];
  const registry = await activateHostKit(createPromptToolsHostExtension({ now: () => clock++ }) as unknown as HostExtension, {
    stateDir: join(root, "state"),
    sessions: { list: async () => listed } as never,
  }, (event) => events.push(event));
  const invoke = <T>(command: string, input: unknown) => registry.invoke(PROMPT_TOOLS_ID, command, input) as Promise<T>;
  return { root, invoke, events };
}

describe("Prompt Tools host: the stash", () => {
  it("keeps a draft per project with its chips and images, lists it without the bytes, and gives it back once", async () => {
    const { root, invoke, events } = await harness();
    const chip = { kind: "text-excerpt", label: "Terminal", payload: { source: "Terminal", text: "$ ls" } };
    const image = { kind: "image", name: "a.png", mimeType: "image/png", size: 3, data: "AAAA" };
    const { entry } = await invoke<{ entry: StashEntry }>("stash-add", { project: "/repo", text: "half a thought", chips: [chip], images: [image] });
    expect(entry.images).toEqual([{ kind: "image", name: "a.png", mimeType: "image/png", size: 3 }]);
    expect(events.map((event) => event.payload)).toEqual([{ project: "/repo" }]);

    const listed = await invoke<StashEntry[]>("stash-list", { project: "/repo" });
    expect(listed).toEqual([entry]);
    expect(await invoke<StashEntry[]>("stash-list", { project: "/other" })).toEqual([]);

    const taken = await invoke<StashEntry>("stash-take", { project: "/repo", id: entry.id });
    expect(taken).toEqual({ ...entry, chips: [chip], images: [image] });
    expect(await invoke("stash-take", { project: "/repo", id: entry.id })).toBeUndefined();
    expect(await invoke<StashEntry[]>("stash-list", { project: "/repo" })).toEqual([]);
    const stash = join(root, "state", PROMPT_TOOLS_ID, "stash");
    const [folder] = await readdir(stash);
    expect(await readdir(join(stash, folder!))).toEqual([]);
  });

  it("keeps the newest twenty and says which one it let go", async () => {
    const { invoke } = await harness();
    const added: StashEntry[] = [];
    for (let index = 0; index < MAX_STASH_ENTRIES; index += 1) {
      added.push((await invoke<{ entry: StashEntry }>("stash-add", { project: "/repo", text: `draft ${index}`, chips: [], images: [] })).entry);
    }
    const last = await invoke<{ entry: StashEntry; evicted?: StashEntry }>("stash-add", { project: "/repo", text: "one more", chips: [], images: [] });
    expect(last.evicted?.id).toBe(added[0]!.id);
    const listed = await invoke<StashEntry[]>("stash-list", { project: "/repo" });
    expect(listed).toHaveLength(MAX_STASH_ENTRIES);
    expect(listed[0]!.text).toBe("one more");
  });

  it("refuses an empty draft, an entry id that is a path, and a drop removes the entry", async () => {
    const { invoke } = await harness();
    await expect(invoke("stash-add", { project: "/repo", text: "  ", chips: [], images: [] })).rejects.toThrow(/nothing to stash/u);
    await expect(invoke("stash-take", { project: "/repo", id: "../../escape" })).rejects.toThrow(/not a stash entry/u);
    await expect(invoke("stash-list", { project: "" })).rejects.toThrow(/belongs to a project/u);
    const { entry } = await invoke<{ entry: StashEntry }>("stash-add", { project: "/repo", text: "x", chips: [], images: [] });
    await invoke("stash-drop", { project: "/repo", id: entry.id });
    expect(await invoke<StashEntry[]>("stash-list", { project: "/repo" })).toEqual([]);
  });
});

describe("Prompt Tools host: the project's prompts", () => {
  it("reads the other threads of the project, newest first, once each, without the context", async () => {
    const { invoke } = await harness([
      { sessionId: "old", cwd: "/repo", modified: 1_000, prompts: [["first ever", 10], ["shared", 20]] },
      { sessionId: "new", cwd: "/repo", modified: 5_000, prompts: [["From Terminal:\n> ls\n\nwhat is this", 40], ["shared", 50]] },
      { sessionId: "current", cwd: "/repo", modified: 9_000, prompts: [["on screen already", 90]] },
      { sessionId: "elsewhere", cwd: "/other", modified: 9_000, prompts: [["not this project", 95]] },
    ]);
    expect(await invoke("project-prompts", { cwd: "/repo", excludeSessionId: "current" })).toEqual(["shared", "what is this", "first ever"]);
  });
});
