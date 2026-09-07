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
    expect(record?.messages).toEqual([{ role: "user", text: "hi", timestamp: 1, clientMessageId: "c1" }, { role: "assistant", text: "hello", timestamp: 2 }]);
    expect((await reloaded.list("/repo")).map((entry) => entry.tauThreadId)).toEqual(["thread"]);
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(1);
    expect(AntigravitySessionStore.defaultPath("/x/sessions")).toBe("/x/tau/antigravity-runtime-sessions.json");
  });
});
