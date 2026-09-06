import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "tau/host-extension";
import { ClaudeRuntimeSessionStore } from "./session-store.js";

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
    await store.appendExchange("tau-session", "/repo", [user, assistant], { knownSkillNames: ["tdd"] });
    await store.setTitle("tau-session", "/repo", "Parser fix", "renamed");

    const reloaded = new ClaudeRuntimeSessionStore({ filePath });
    const restored = await reloaded.get("tau-session");
    expect(restored).toMatchObject({
      tauThreadId: "tau-session",
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

  it("normalizes a Tau-authorized runtime wrapper once before persisting it", async () => {
    const { filePath } = await temporaryStore();
    const raw = '<skill name="tdd" location="/private/SKILL.md">\nSECRET BODY\n</skill>\n\nVisible request';
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.appendExchange("tau-session", "/repo", [{
      id: "user",
      role: "user",
      text: raw,
      timestamp: 1,
      skill: { name: "tdd", command: "/tdd", copyText: "/tdd Visible request" },
    }], { knownSkillNames: ["tdd"] });
    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.messages[0]?.text).toBe("Visible request");
    expect(JSON.stringify(restored)).not.toContain("SECRET BODY");
  });

  it("never migrates a raw envelope when a catalog arrives after load", async () => {
    const { filePath } = await temporaryStore();
    await mkdir(join(filePath, ".."), { recursive: true });
    const raw = '<skill name="tdd" location="/private/SKILL.md">\nSECRET BODY\n</skill>\n\nVisible request';
    await writeFile(filePath, JSON.stringify({ sessions: [{
      tauThreadId: "tau-session",
      claudeSessionId: "123e4567-e89b-12d3-a456-426614174000",
      cwd: "/repo",
      started: true,
      messages: [{
        role: "user",
        text: raw,
        timestamp: 1,
        skill: { name: "tdd", command: "/tdd", copyText: "/tdd Visible request" },
      }],
      updatedAt: 1,
    }] }), { encoding: "utf8", mode: 0o600 });
    const store = new ClaudeRuntimeSessionStore({ filePath });
    const before = await readFile(filePath, "utf8");
    expect((await store.get("tau-session"))?.messages[0]?.text).toBe(raw);
    await store.setKnownSkillNames(["tdd"]);
    expect((await store.get("tau-session"))?.messages[0]?.text).toBe(raw);
    expect(await readFile(filePath, "utf8")).toBe(before);
    expect((await new ClaudeRuntimeSessionStore({ filePath, knownSkillNames: ["tdd"] }).get("tau-session"))?.messages[0]?.text)
      .toBe(raw);
  });

  it("keeps workspace-scoped unknown wrappers immutable when another workspace knows them", async () => {
    const { filePath } = await temporaryStore();
    const raw = '<skill name="removed" location="/workspace-a/.agents/SKILL.md">\nSECRET FROM A\n</skill>\n\nKeep this request raw';
    const workspaceA = new ClaudeRuntimeSessionStore({ filePath });
    await workspaceA.appendExchange("thread-a", "/workspace-a", [{
      id: "a-user",
      role: "user",
      text: raw,
      timestamp: 1,
    }]);
    const before = await readFile(filePath, "utf8");

    // Opening workspace B supplies a different runtime catalog. It must not
    // reinterpret A's already persisted append-only payload.
    const workspaceB = new ClaudeRuntimeSessionStore({ filePath });
    await workspaceB.setKnownSkillNames(["removed"]);
    expect((await workspaceB.get("thread-a"))?.messages[0]?.text).toBe(raw);
    expect(await readFile(filePath, "utf8")).toBe(before);

    const reloadedA = await new ClaudeRuntimeSessionStore({ filePath }).get("thread-a");
    expect(reloadedA?.messages[0]?.text).toBe(raw);
    expect(reloadedA?.messages[0]?.text).toContain("SECRET FROM A");
  });

  it("keeps unknown and malformed wrappers lossless across a restart", async () => {
    const { filePath } = await temporaryStore();
    const unknown = '<skill name="removed" location="/private/removed/SKILL.md">\nSECRET BODY\n</skill>\n\nKeep this raw';
    const unknownWithMetadata = '<skill name="removed" location="/private/removed/SKILL.md">\nSECOND SECRET\n</skill>\n\nKeep this raw too';
    const malformed = '<skill name="tdd" location="/private/tdd/SKILL.md">\nBODY\n</skill\n\nKeep this malformed';
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.appendExchange("tau-session", "/repo", [
      { id: "unknown", role: "user", text: unknown, timestamp: 1 },
      { id: "unknown-with-metadata", role: "user", text: unknownWithMetadata, skill: { name: "removed", command: "/removed", copyText: "/removed Keep this raw too" }, timestamp: 2 },
      { id: "malformed", role: "user", text: malformed, skill: { name: "tdd", command: "/tdd", copyText: "/tdd Keep this malformed" }, timestamp: 3 },
    ]);

    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.messages.map((message) => message.text)).toEqual([unknown, unknownWithMetadata, malformed]);
    expect(restored?.messages[1]?.skill).toBeUndefined();
    expect(JSON.stringify(restored)).toContain("SECRET BODY");
    expect(JSON.stringify(restored)).toContain("SECOND SECRET");
    expect(JSON.stringify(restored)).toContain("/private/removed/SKILL.md");
  });

  it("never derives a title from raw runtime wrappers", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.setTitle("tau-session", "/repo", '<skill name="removed" location="/private/SKILL.md">\nSECRET\n</skill>\n\nVisible title', "generated");

    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.title).toBe("Skill invocation");
    expect(JSON.stringify(restored)).not.toContain("SECRET");
    expect(JSON.stringify(restored)).not.toContain("location=");
  });

  it("does not mistake ordinary location text for a runtime wrapper", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.setTitle("tau-session", "/repo", "Inspect location=/repo", "renamed");

    expect((await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session"))?.title)
      .toBe("Inspect location=/repo");
  });

  it("rejects forged persisted skill metadata without changing visible content", async () => {
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
    expect(restored?.messages[0]?.skill).toBeUndefined();
    expect(restored?.messages[0]?.text).toBe("Please inspect location=/repo");
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

  it("chunks oversized messages without dropping bytes", async () => {
    const { filePath } = await temporaryStore();
    const largeText = `${"x".repeat(512 * 1024)}🙂\ntrailing whitespace  `;
    const message: UiMessage = { id: "large", role: "user", text: largeText, timestamp: 1 };
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.appendExchange("tau-session", "/repo", [message]);

    const onDisk = JSON.parse(await readFile(filePath, "utf8")) as { sessions: Array<{ messages: Array<{ text?: string; textChunks?: string[] }> }> };
    expect(onDisk.sessions[0]?.messages[0]?.text).toBeUndefined();
    expect(onDisk.sessions[0]?.messages[0]?.textChunks?.length).toBeGreaterThan(1);
    const restored = await new ClaudeRuntimeSessionStore({ filePath }).get("tau-session");
    expect(restored?.messages[0]?.text).toBe(largeText);
  });

  it("treats identical client replays as idempotent and rejects conflicting replays", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    const message: UiMessage = { id: "first", role: "user", text: "first", clientMessageId: "request-1", timestamp: 1 };
    await store.appendExchange("tau-session", "/repo", [message]);
    await store.appendExchange("tau-session", "/repo", [{ ...message, id: "replayed" }]);
    expect((await store.get("tau-session"))?.messages).toHaveLength(1);
    await expect(store.appendExchange("tau-session", "/repo", [{ ...message, text: "tampered" }]))
      .rejects.toThrow("conflicting message id");
    expect((await store.get("tau-session"))?.messages).toEqual([expect.objectContaining({ text: "first", clientMessageId: "request-1" })]);
  });

  it("does not let a session id cross workspace boundaries", async () => {
    const { filePath } = await temporaryStore();
    const store = new ClaudeRuntimeSessionStore({ filePath });
    await store.ensure("tau-session", "/repo-a");
    await expect(store.ensure("tau-session", "/repo-b")).rejects.toThrow("another workspace");
  });

  it("loads a legacy bare-array file", async () => {
    const { filePath } = await temporaryStore();
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, JSON.stringify([{
      tauThreadId: "tau-session",
      claudeSessionId: "123e4567-e89b-12d3-a456-426614174000",
      cwd: "/repo",
      started: true,
      messages: [],
      updatedAt: 1,
    }]), "utf8");

    const store = new ClaudeRuntimeSessionStore({ filePath });
    expect(await store.get("tau-session")).toMatchObject({ cwd: "/repo", started: true });
  });

  it("quarantines an unparsable file instead of silently starting empty on top of it", async () => {
    const { filePath } = await temporaryStore();
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, "{not valid json", "utf8");

    const store = new ClaudeRuntimeSessionStore({ filePath });
    expect(await store.list()).toEqual([]);

    const directory = join(filePath, "..");
    const entries = await readdir(directory);
    expect(entries).not.toContain("sessions.json");
    expect(entries.some((name) => name.startsWith("sessions.json.corrupt-"))).toBe(true);
  });

  it("reads a newer-versioned file best-effort without downgrading it on a mere load", async () => {
    const { filePath } = await temporaryStore();
    await mkdir(join(filePath, ".."), { recursive: true });
    const original = JSON.stringify({
      version: 99,
      sessions: [{
        tauThreadId: "tau-session",
        claudeSessionId: "123e4567-e89b-12d3-a456-426614174000",
        cwd: "/repo",
        started: true,
        messages: [],
        updatedAt: 1,
      }],
      futureField: "kept by a newer client, not this one",
    });
    await writeFile(filePath, original, "utf8");
    const logger = { warn: vi.fn() };

    const store = new ClaudeRuntimeSessionStore({ filePath, logger });
    expect(await store.get("tau-session")).toMatchObject({ cwd: "/repo", started: true });
    expect(logger.warn).toHaveBeenCalled();
    expect(await readFile(filePath, "utf8")).toBe(original);
  });
});

describe("ClaudeRuntimeSessionStore.defaultPath", () => {
  it("sits beside the Pi session directory, so a redirected store stays isolated", () => {
    expect(ClaudeRuntimeSessionStore.defaultPath("/home/u/.pi/agent/sessions")).toBe("/home/u/.pi/agent/tau/claude-runtime-sessions.json");
    expect(ClaudeRuntimeSessionStore.defaultPath("/repo/.tau-dev/pi-sessions")).toBe("/repo/.tau-dev/tau/claude-runtime-sessions.json");
  });
});
