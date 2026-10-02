import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AcpSessionStore } from "./session-store.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

async function store() {
  const directory = await mkdtemp(join(tmpdir(), "tau-acp-store-"));
  directories.push(directory);
  return new AcpSessionStore({ filePath: join(directory, "tau", "fake-runtime-sessions.json"), backendKind: "fake", agent: "Fake", now: () => 7 });
}

const total = (turns: number) => ({ inputTokens: 10 * turns, outputTokens: 2 * turns, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 12 * turns, costUsd: 0.5 * turns, turns });
const turn = (at: number, model = "m-1") => ({ provider: "xai", model, ...total(1), at });

describe("AcpSessionStore tallies", () => {
  it("answers what a thread was billed for, per model, and a new turn counts at once", async () => {
    const acp = await store();
    await acp.recordUsage("t", "/repo", total(1), turn(1));
    await acp.recordUsage("t", "/repo", total(2), turn(2, "m-2"));
    expect(acp.talliesOf("t")).toEqual([{ provider: "xai", model: "m-1", ...total(1) }, { provider: "xai", model: "m-2", ...total(1) }]);
    acp.talliesOf("t")[0]!.costUsd = 99;
    await acp.recordUsage("t", "/repo", total(3), turn(3));
    expect(acp.talliesOf("t")).toEqual([{ provider: "xai", model: "m-1", ...total(2) }, { provider: "xai", model: "m-2", ...total(1) }]);
    expect(acp.talliesOf("missing")).toEqual([]);
  });

  it("names a thread that kept only its total by its origin, and leaves one without usage out", async () => {
    const acp = await store();
    await acp.recordUsage("legacy", "/repo", total(3));
    await acp.setObservedModel("legacy", "/repo", "m-9");
    await acp.ensure("unused", "/repo");
    expect(acp.talliesOf("legacy", (record) => ({ provider: "xai", ...(record.observedModel ? { model: record.observedModel } : {}) }))).toEqual([{ provider: "xai", model: "m-9", ...total(3) }]);
    expect(acp.talliesOf("legacy")).toEqual([total(3)]);
    expect(acp.talliesOf("unused")).toEqual([]);
  });
});
