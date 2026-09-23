import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AntigravitySessionStore } from "./session-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

describe("AntigravitySessionStore", () => {
  it("keeps the thread's session id, transcript, title, usage and model across a reload", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agy-store-"));
    directories.push(directory);
    const filePath = join(directory, "tau", "antigravity-runtime-sessions.json");
    let clock = 10;
    const store = new AntigravitySessionStore({ filePath, now: () => clock++ });
    await store.ensure("thread", "/repo");
    await store.setAcpSession("thread", "/repo", "acp-1");
    await store.appendMessages("thread", "/repo", [{ id: "u", role: "user", text: "hi", timestamp: 1, clientMessageId: "c1" }, { id: "a", role: "assistant", text: "hello", timestamp: 2 }]);
    await store.appendMessages("thread", "/repo", [{ id: "u2", role: "user", text: "hi", timestamp: 1, clientMessageId: "c1" }]);
    await expect(store.appendMessages("thread", "/repo", [{ id: "u3", role: "user", text: "other", timestamp: 1, clientMessageId: "c1" }])).rejects.toThrow(/conflicting/u);
    await store.setTitle("thread", "/repo", "  Greeting  ", "derived");
    await store.recordUsage("thread", "/repo", { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 3, costUsd: 0, turns: 1 });
    await store.setModel("thread", "/repo", "gemini-3.8-flash-low");
    await expect(store.ensure("thread", "/elsewhere")).rejects.toThrow(/another workspace/u);

    const reloaded = new AntigravitySessionStore({ filePath });
    const record = await reloaded.get("thread");
    expect(record).toMatchObject({ backendKind: "antigravity", acpSessionId: "acp-1", title: "Greeting", titleSource: "derived", model: "gemini-3.8-flash-low", usage: { totalTokens: 3 } });
    // The ids the transcript showed come back, so tool cards anchored to them find them.
    expect(record?.messages).toEqual([{ id: "u", role: "user", text: "hi", timestamp: 1, clientMessageId: "c1" }, { id: "a", role: "assistant", text: "hello", timestamp: 2 }]);
    expect((await reloaded.list("/repo")).map((entry) => entry.tauThreadId)).toEqual(["thread"]);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(1);
    expect(AntigravitySessionStore.defaultPath("/x/sessions")).toBe("/x/tau/antigravity-runtime-sessions.json");
  });

  it("keeps the model catalog beside the sessions, so a picker has something before a session exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agy-store-"));
    directories.push(directory);
    const filePath = join(directory, "sessions.json");
    const store = new AntigravitySessionStore({ filePath });
    expect(await store.listModels()).toEqual([]);
    await store.setModels([{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }, { value: "", name: "nameless" }]);
    // An empty report never wipes what the last session knew.
    await store.setModels([]);
    expect(await new AntigravitySessionStore({ filePath }).listModels()).toEqual([{ value: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" }]);
  });

  it("hands a thread's record to the trash and takes the same record back", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-agy-store-"));
    directories.push(directory);
    const filePath = join(directory, "sessions.json");
    const store = new AntigravitySessionStore({ filePath });
    await store.ensure("thread", "/repo");
    await store.setAcpSession("thread", "/repo", "acp-1");
    const taken = await store.take("thread");
    expect(await new AntigravitySessionStore({ filePath }).get("thread")).toBeUndefined();
    await store.put("thread", JSON.parse(JSON.stringify(taken)));
    expect(await new AntigravitySessionStore({ filePath }).get("thread")).toMatchObject({ acpSessionId: "acp-1" });
  });
});
