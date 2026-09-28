import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { readSessionModel } from "./session-model-provider.js";

async function withSession(entries: unknown[], inspect: (path: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(`${tmpdir()}/tau-model-provider-`);
  const path = `${directory}/thread.jsonl`;
  try {
    await writeFile(path, entries.map((entry) => JSON.stringify(entry)).join("\n"));
    await inspect(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("persisted session model provider", () => {
  it("uses the latest provider on the selected branch", async () => {
    await withSession([
      { type: "session", id: "thread", timestamp: "2026-09-01T12:00:00.000Z", cwd: "/project" },
      { type: "model_change", id: "openai", parentId: null, provider: "openai-codex", modelId: "gpt-5" },
      { type: "message", id: "old-leaf", parentId: "openai", message: { role: "user", content: "old branch" } },
      { type: "model_change", id: "claude", parentId: "openai", provider: "anthropic", modelId: "claude" },
      { type: "message", id: "active-leaf", parentId: "claude", message: { role: "user", content: "active branch" } },
    ], async (path) => {
      expect(await readSessionModel(path)).toEqual({ provider: "anthropic", id: "claude" });
    });
  });

  it("reads the provider from assistant messages in older sessions", async () => {
    await withSession([
      { type: "session", id: "thread", timestamp: "2026-09-01T12:00:00.000Z", cwd: "/project" },
      { type: "message", id: "assistant", parentId: null, message: { role: "assistant", provider: "google", model: "gemini", content: [] } },
    ], async (path) => {
      expect(await readSessionModel(path)).toEqual({ provider: "google", id: "gemini" });
    });
  });
});
