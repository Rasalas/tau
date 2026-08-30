import { describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts.js";
import { buildTitleConversation, mergeSessionIndexScan, reconcileActiveThreadShell, sessionIndexUpdates } from "./pi-host.js";

function shell(id: string, modifiedAt: number, title = id): UiSession {
  return { id, path: `/sessions/${id}.jsonl`, title, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 1 };
}

describe("session index reconciliation", () => {
  it("titles a persisted conversation when the fresh runtime buffer is not ready", () => {
    expect(buildTitleConversation([], [
      { role: "user", content: "Persisted question" },
      { role: "assistant", content: [{ type: "text", text: "Persisted answer" }] },
    ])).toBe("user: Persisted question\n\nassistant: Persisted answer");
  });

  it("skips non-text assistant records before applying the title context limit", () => {
    const toolOnly = { role: "assistant", content: [{ type: "toolCall", name: "read" }] };
    expect(buildTitleConversation([
      toolOnly, toolOnly, toolOnly, toolOnly,
      { role: "user", content: "Visible request" },
    ])).toBe("user: Visible request");
  });

  it("does not rename or reorder an existing shell merely because it was selected", () => {
    const existing = shell("selected", 100, "Stable title");
    const selected = reconcileActiveThreadShell({
      id: existing.id,
      path: existing.path,
      derivedTitle: "Different first message",
      now: 200,
      projectPath: existing.projectPath,
      projectName: existing.projectName,
      branch: "main",
      messageCount: 5,
    }, existing, false);
    expect(selected.title).toBe("Stable title");
    expect(selected.modifiedAt).toBe(100);
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
