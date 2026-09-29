import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CodexSessionStore } from "./session-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "tau-codex-store-"));
  directories.push(directory);
  const filePath = join(directory, "codex-runtime-sessions.json");
  return { filePath, make: () => new CodexSessionStore({ filePath, now: () => 5 }) };
}

describe("CodexSessionStore", () => {
  it("sits beside the Pi session directory, never inside the user's Codex home", () => {
    expect(CodexSessionStore.defaultPath("/data/pi/sessions")).toBe("/data/pi/tau/codex-runtime-sessions.json");
  });

  it("keeps the thread mapping, transcript, selection and usage across instances, private to the user", async () => {
    const { filePath, make } = await store();
    const first = make();
    await first.ensure("tau-1", "/repo");
    await first.setCodexThread("tau-1", "/repo", "codex-1");
    await first.appendMessages("tau-1", "/repo", [{ id: "u", role: "user", text: "Hi", timestamp: 1, clientMessageId: "m1" }, { id: "a", role: "assistant", text: "Hello", timestamp: 2 }]);
    await first.appendMessages("tau-1", "/repo", [{ id: "u", role: "user", text: "Hi", timestamp: 1, clientMessageId: "m1" }]);
    await first.setSelection("tau-1", "/repo", { model: "gpt-5.6-luna", effort: "low" });
    await first.setSelection("tau-1", "/repo", { effort: null });
    await first.setModels([{ id: "gpt-5.6-luna", name: "GPT-5.6-Luna", efforts: ["low"], defaultEffort: "low" }]);
    expect((await stat(filePath)).mode & 0o777).toBe(0o600);

    const second = make();
    expect(await second.get("tau-1")).toEqual({
      backendKind: "codex", tauThreadId: "tau-1", codexThreadId: "codex-1", cwd: "/repo", model: "gpt-5.6-luna", updatedAt: 5,
      messages: [{ id: "u", role: "user", text: "Hi", timestamp: 1, clientMessageId: "m1" }, { id: "a", role: "assistant", text: "Hello", timestamp: 2 }],
    });
    expect(await second.listModels()).toEqual([{ id: "gpt-5.6-luna", name: "GPT-5.6-Luna", efforts: ["low"], defaultEffort: "low" }]);
    await expect(second.ensure("tau-1", "/elsewhere")).rejects.toThrow("another workspace");
    await expect(second.appendMessages("tau-1", "/repo", [{ id: "x", role: "user", text: "Different", timestamp: 3, clientMessageId: "m1" }])).rejects.toThrow("different message");
    expect(JSON.parse(await readFile(filePath, "utf8")).version).toBe(1);
  });

  it("hands a thread's record to the trash and takes the same record back", async () => {
    const { make } = await store();
    const first = make();
    await first.ensure("tau-1", "/repo");
    await first.setCodexThread("tau-1", "/repo", "codex-1");
    const taken = await first.take("tau-1");
    expect(await make().get("tau-1")).toBeUndefined();
    await expect(first.put("tau-2", taken)).rejects.toThrow(/not the Codex thread/u);
    await first.put("tau-1", JSON.parse(JSON.stringify(taken)));
    expect(await make().get("tau-1")).toMatchObject({ codexThreadId: "codex-1", cwd: "/repo" });
    await expect(first.put("tau-1", taken)).rejects.toThrow(/exists again/u);
  });

  it("files each thread under its instance and keeps each instance's models apart", async () => {
    const { filePath, make } = await store();
    const first = make();
    await first.ensure("old", "/repo");
    await first.ensure("work-1", "/repo", "work");
    await first.setModels([{ id: "gpt-5.5", name: "GPT-5.5", efforts: [] }]);
    await first.setModels([{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", efforts: ["low"] }], "work");
    await expect(first.ensure("work-1", "/repo", "default")).rejects.toThrow("another instance");

    const again = make();
    await expect(again.list("default")).resolves.toEqual([expect.objectContaining({ tauThreadId: "old" })]);
    await expect(again.list("work")).resolves.toEqual([expect.objectContaining({ tauThreadId: "work-1", instance: "work" })]);
    await expect(again.list()).resolves.toHaveLength(2);
    await expect(again.listModels()).resolves.toEqual([{ id: "gpt-5.5", name: "GPT-5.5", efforts: [] }]);
    await expect(again.listModels("work")).resolves.toEqual([{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna", efforts: ["low"] }]);
    // A file from before instances reads the same: the default instance's models stay under `models`.
    const saved = JSON.parse(await readFile(filePath, "utf8")) as { models: unknown[]; instanceModels: Record<string, unknown[]>; sessions: Array<{ instance?: string }> };
    expect(saved.models).toHaveLength(1);
    expect(Object.keys(saved.instanceModels)).toEqual(["work"]);
    expect(saved.sessions.map((session) => session.instance)).toEqual([undefined, "work"]);
  });

  it("answers what a thread was billed for, and a new turn counts at once", async () => {
    const { make } = await store();
    const codex = make();
    const turn = (at: number) => ({ provider: "openai", model: "gpt-5.6-luna", inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.5, turns: 1, at });
    const total = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12, costUsd: 0.5, turns: 1 };
    await codex.recordUsage("tau-1", "/repo", total, turn(1));
    expect(codex.talliesOf("tau-1")).toEqual([{ provider: "openai", model: "gpt-5.6-luna", ...total }]);
    codex.talliesOf("tau-1")[0]!.costUsd = 99;
    await codex.recordUsage("tau-1", "/repo", total, turn(2));
    expect(codex.talliesOf("tau-1")).toEqual([{ provider: "openai", model: "gpt-5.6-luna", ...total, inputTokens: 20, outputTokens: 4, totalTokens: 24, costUsd: 1, turns: 2 }]);
    expect(codex.talliesOf("missing")).toEqual([]);
  });
});
