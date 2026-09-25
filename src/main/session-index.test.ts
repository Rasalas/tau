import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts.js";
import { mapSessions, mergeSessionIndexScan, reconcileActiveThreadShell, sessionIndexUpdates, sessionShellEqual } from "./host-messages.js";

function shell(id: string, modifiedAt: number, title = id): UiSession {
  return { id, path: `/sessions/${id}.jsonl`, title, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 1 };
}

describe("session index reconciliation", () => {
  it("keeps every persisted thread when the renderer virtualizes the list", async () => {
    const sessions = Array.from({ length: 120 }, (_, index) => ({
      id: `thread-${index}`,
      path: `/sessions/thread-${index}.jsonl`,
      cwd: `/projects/project-${index % 3}`,
      modified: new Date(10_000 - index),
      messageCount: 1,
      name: `Thread ${index}`,
      firstMessage: `Prompt ${index}`,
    }));

    const mapped = await mapSessions(
      sessions as Parameters<typeof mapSessions>[0],
      "/fallback",
      async () => "main",
    );

    expect(mapped).toHaveLength(120);
    expect(mapped.map((thread) => thread.id)).toContain("thread-119");
  });

  it("includes the selected model provider for persisted Pi threads", async () => {
    const directory = await mkdtemp(`${tmpdir()}/tau-session-provider-`);
    const path = `${directory}/thread.jsonl`;
    try {
      await writeFile(path, [
        JSON.stringify({ type: "session", version: 3, id: "thread", timestamp: "2026-09-01T12:00:00.000Z", cwd: "/project" }),
        JSON.stringify({ type: "model_change", id: "model", parentId: null, timestamp: "2026-09-01T12:00:01.000Z", provider: "openai-codex", modelId: "gpt-5" }),
      ].join("\n"));
      const [mapped] = await mapSessions([{
        id: "thread",
        path,
        cwd: "/project",
        created: new Date("2026-09-01T12:00:00.000Z"),
        modified: new Date("2026-09-01T12:00:01.000Z"),
        messageCount: 0,
        firstMessage: "Provider test",
        allMessagesText: "Provider test",
      }], "/fallback", async () => "main");

      expect(mapped?.modelProvider).toBe("openai-codex");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("carries the thread that spawned a session into its shell", async () => {
    const [mapped] = await mapSessions([{
      id: "child",
      path: "/sessions/child.jsonl",
      cwd: "/project",
      created: new Date(1_000),
      modified: new Date(2_000),
      messageCount: 1,
      firstMessage: "Reply with A",
      allMessagesText: "Reply with A",
    }] as Parameters<typeof mapSessions>[0], "/fallback", async () => "main", undefined, undefined, undefined, () => "parent");

    expect(mapped?.parentThreadId).toBe("parent");
    // A shell that gained the link is republished, not silently kept.
    expect(sessionShellEqual(mapped!, { ...mapped!, parentThreadId: undefined })).toBe(false);
  });

  it("carries where an imported session came from, and keeps it once the thread is live", async () => {
    const origin = { hostId: "host-a", threadId: "thread-a" };
    const [mapped] = await mapSessions([{
      id: "imported",
      path: "/sessions/imported.jsonl",
      cwd: "/project",
      modified: new Date(2_000),
      messageCount: 2,
      firstMessage: "Say one word",
      allMessagesText: "Say one word",
    }] as Parameters<typeof mapSessions>[0], "/fallback", async () => "main", undefined, undefined, undefined, undefined, () => origin);

    expect(mapped?.origin).toEqual(origin);
    expect(sessionShellEqual(mapped!, { ...mapped!, origin: undefined })).toBe(false);
    const live = reconcileActiveThreadShell({
      id: mapped!.id, path: mapped!.path, derivedTitle: "Say one word", now: 3_000,
      projectPath: "/project", projectName: "project", messageCount: 3,
    }, mapped, true);
    expect(live.origin).toEqual(origin);
  });

  it("does not rename or reorder an existing shell merely because it was selected", () => {
    const existing = { ...shell("selected", 100, "Stable title"), modelProvider: "anthropic" };
    const selected = reconcileActiveThreadShell({
      id: existing.id,
      path: existing.path,
      derivedTitle: "Different first message",
      now: 200,
      projectPath: existing.projectPath,
      projectName: existing.projectName,
      projectLabel: "main",
      messageCount: 5,
    }, existing, false);
    expect(selected.title).toBe("Stable title");
    expect(selected.modifiedAt).toBe(100);
    expect(selected.modelProvider).toBe("anthropic");
  });

  it("publishes create, rename, project move, and delete as focused shell updates", () => {
    const moved = { ...shell("renamed", 120, "New title"), projectPath: "/other", projectName: "other" };
    const updates = sessionIndexUpdates(
      [shell("renamed", 100, "Old title"), shell("deleted", 90)],
      [moved, shell("created", 130)],
    );
    expect(updates.map((update) => update.type)).toEqual(["thread-shell", "thread-shell", "thread-shell"]);
    expect(updates[0]).toMatchObject({ update: { sessionId: "renamed", shell: moved } });
    expect(updates[1]).toMatchObject({ update: { sessionId: "created" } });
    expect(updates[2]).toMatchObject({ update: { sessionId: "deleted", removed: true } });
  });

  it("does not let a slow startup scan overwrite or drop newer shell updates", () => {
    const startedAt = 100;
    const merged = mergeSessionIndexScan(
      [shell("active", 90, "stale"), shell("old", 80)],
      [shell("active", 110, "fresh"), shell("created", 120)],
      startedAt,
    );
    expect(merged.find((session) => session.id === "active")?.title).toBe("fresh");
    expect(merged.map((session) => session.id)).toContain("created");
  });
});
