import { mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { UiSession } from "../shared/contracts.js";
import { mapSessions, mergeSessionIndexScan, reconcileActiveThreadShell, sessionIndexUpdates } from "./host-messages.js";
import { prioritizeRestoreTargetSession } from "./extensions/workspace-kit-lifecycle.js";
import { buildTitleConversation } from "./extensions/thread-titles-host-extension.js";

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

  it("removes runtime skill wrappers from fallback title context", () => {
    const wrapper = `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions\n</skill>\n\nReview the parser`;
    const conversation = buildTitleConversation([{ role: "user", content: wrapper, skill: { name: "tdd", command: "/skill:tdd" } }]);
    expect(conversation).toBe("user: Review the parser");
    expect(conversation).not.toContain("Injected instructions");
    expect(conversation).not.toContain("/Users/me/.pi/skills");
  });

  it("uses a sanitized fallback for malformed runtime wrappers", () => {
    const malformed = `<skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions\n</skill`;
    const conversation = buildTitleConversation([{ role: "user", content: malformed }]);
    expect(conversation).toBe("user: Skill invocation");
    expect(conversation).not.toContain("Injected instructions");
    expect(conversation).not.toContain("/Users/me/.pi/skills");
  });

  it("sanitizes malformed wrappers even when their opening tag is split", () => {
    const malformed = `<skill\nname="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions`;
    const conversation = buildTitleConversation([{ role: "user", content: malformed }]);
    expect(conversation).toBe("user: Skill invocation");
    expect(conversation).not.toContain("Injected instructions");
    expect(conversation).not.toContain("/Users/me/.pi/skills");
  });

  it("sanitizes a malformed wrapper after leading blank lines", () => {
    const malformed = `\n  <skill name="tdd" location="/Users/me/.pi/skills/tdd/SKILL.md">\nInjected instructions`;
    const conversation = buildTitleConversation([{ role: "user", content: malformed }]);
    expect(conversation).toBe("user: Skill invocation");
    expect(conversation).not.toContain("Injected instructions");
    expect(conversation).not.toContain("/Users/me/.pi/skills");
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
      projectLabel: "main",
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

  it("keeps the restored target newer than its backup for restart discovery", async () => {
    const directory = await mkdtemp(`${tmpdir()}/tau-restore-mtime-`);
    const targetPath = `${directory}/target.jsonl`;
    const backupPath = `${directory}/backup.jsonl`;
    const header = (id: string) => `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/project" })}\n`;
    try {
      await writeFile(targetPath, header("target"));
      await writeFile(backupPath, header("backup"));
      await utimes(targetPath, new Date(1_000), new Date(1_000));
      await utimes(backupPath, new Date(2_000), new Date(2_000));

      await prioritizeRestoreTargetSession(targetPath, backupPath);

      // continueRecent delegates to the SDK's findMostRecentSession helper.
      expect(SessionManager.continueRecent("/project", directory).getSessionFile()).toBe(targetPath);
      expect((await stat(targetPath)).mtimeMs).toBeGreaterThan((await stat(backupPath)).mtimeMs);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
