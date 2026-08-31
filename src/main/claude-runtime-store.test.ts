import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import type { UiMessage } from "../shared/contracts.js";
import { ClaudeRuntimeSessionStore } from "./claude-runtime-store.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function temporaryStore() {
  const directory = await mkdtemp(join(tmpdir(), "tau-claude-store-"));
  temporaryDirectories.push(directory);
  return { directory, filePath: join(directory, "tau", "sessions.json") };
}

describe("Claude runtime session store", () => {
  it("atomically reloads runtime ids, visible transcript metadata, and title source", async () => {
    const { directory, filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath, now: () => 10 });
    const record = await store.ensure("tau-session", "/repo");
    await store.markStarted("tau-session", "/repo");
    const user: UiMessage = {
      id: "user",
      role: "user",
      text: "Fix the parser",
      clientMessageId: "request-1",
      skill: { name: "tdd", command: "/tdd", copyText: "/tdd Fix the parser" },
      timestamp: 11,
    };
    const assistant: UiMessage = { id: "assistant", role: "assistant", text: "Done", timestamp: 12 };
    await store.appendExchange("tau-session", "/repo", [user, assistant]);
    await store.setTitle("tau-session", "/repo", "Parser fix", "renamed");

    const reloaded = new ClaudeRuntimeSessionStore({ filePath });
    const restored = await reloaded.get("tau-session");
    expect(restored).toMatchObject({
      tauSessionId: "tau-session",
      claudeSessionId: record.claudeSessionId,
      cwd: "/repo",
      started: true,
      title: "Parser fix",
      titleSource: "renamed",
      messages: [{ role: "user", text: user.text, clientMessageId: user.clientMessageId, skill: user.skill, timestamp: user.timestamp }, { role: "assistant", text: assistant.text, timestamp: assistant.timestamp }],
    });
    expect(restored?.messages.some((message) => message.text.includes("<skill"))).toBe(false);

    const fileMode = (await stat(filePath)).mode & 0o777;
    const directoryMode = (await stat(join(directory, "tau"))).mode & 0o777;
    expect(fileMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    expect(JSON.parse(await readFile(filePath, "utf8")).sessions).toHaveLength(1);
    expect(await reloaded.list()).toHaveLength(1);
  });

  it("strips runtime wrappers before accepting persisted user content", async () => {
    const { filePath } = await temporaryStore();
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, JSON.stringify({ sessions: [{
      tauSessionId: "tau-session",
      claudeSessionId: "123e4567-e89b-12d3-a456-426614174000",
      cwd: "/repo",
      started: true,
      messages: [{
        role: "user",
        text: '<skill name="tdd" location="/private/SKILL.md">\nSECRET BODY\n</skill>\n\nVisible request',
        timestamp: 1,
        skill: { name: "tdd", command: "/tdd", copyText: "/tdd Visible request" },
      }],
      updatedAt: 1,
    }] }), { encoding: "utf8", mode: 0o600 });
    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.messages[0]?.text).toBe("Visible request");
    expect(JSON.stringify(restored)).not.toContain("SECRET BODY");
    await chmod(filePath, 0o600);
  });

  it("never persists runtime wrappers as a title", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.setTitle("tau-session", "/repo", '<skill name="removed" location="/private/SKILL.md">\nSECRET\n</skill>\n\nVisible title', "generated");

    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.title).toBe("Visible title");
    expect(JSON.stringify(restored)).not.toContain("SECRET");
    expect(JSON.stringify(restored)).not.toContain("location=");
  });

  it("rebuilds persisted skill copy text from visible content", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.appendExchange("tau-session", "/repo", [{
      id: "user",
      role: "user",
      text: "Please inspect location=/repo",
      skill: { name: "tdd", command: "/tdd", copyText: "/tdd SECRET <skill location=/private>" },
      timestamp: 1,
    }]);

    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.messages[0]?.skill?.copyText).toBe("/tdd Please inspect location=/repo");
    expect(JSON.stringify(restored)).not.toContain("SECRET");
  });

  it("keeps the complete append-only history and durable launch attempt state", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath, now: () => 20 });
    const messages: UiMessage[] = Array.from({ length: 520 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      text: `message ${index}`,
      timestamp: index,
    }));
    await store.appendExchange("tau-session", "/repo", messages);
    await store.markAttempted("tau-session", "/repo");
    const attempted = await store.get("tau-session");
    expect(attempted?.messages).toHaveLength(520);
    expect(attempted).toMatchObject({ attempted: true, attemptCount: 1, lastAttemptOutcome: "pending", createFallbackUsed: false });

    await store.markCreateFallbackUsed("tau-session", "/repo");
    await store.markAttemptOutcome("tau-session", "/repo", "missing");
    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored).toMatchObject({ attempted: true, attemptCount: 1, lastAttemptOutcome: "missing", createFallbackUsed: true });
    expect(restored?.messages.at(-1)?.text).toBe("message 519");
  });

  it("does not let a session id cross workspace boundaries", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.ensure("tau-session", "/repo-a");
    await expect(store.ensure("tau-session", "/repo-b")).rejects.toThrow("another workspace");
  });
});
