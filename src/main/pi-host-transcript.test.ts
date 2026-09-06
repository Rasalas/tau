import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { UiSession } from "../shared/contracts.js";
import { PiHost } from "./pi-host.js";

const SESSION_ID = "released-thread";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

/** The session file of a thread this run never opened a runtime for. */
async function sessionFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tau-host-transcript-"));
  directories.push(directory);
  const path = join(directory, `${SESSION_ID}.jsonl`);
  const timestamp = new Date(Date.UTC(2026, 0, 1)).toISOString();
  await writeFile(path, [
    JSON.stringify({ type: "session", version: 3, id: SESSION_ID, timestamp, cwd: "/repo" }),
    JSON.stringify({
      type: "message", id: "entry-1", parentId: null, timestamp,
      message: { role: "user", content: [{ type: "text", text: "Report the index" }], timestamp: 1 },
    }),
    JSON.stringify({
      type: "message", id: "entry-2", parentId: "entry-1", timestamp,
      message: { role: "assistant", content: [{ type: "text", text: "Index 3" }], timestamp: 2 },
    }),
    "",
  ].join("\n"));
  return path;
}

function hostWithIndex(sessions: UiSession[]): PiHost {
  const projectHistory = { list: () => [], isHidden: () => false, remember: async () => undefined };
  const host = new PiHost("/repo", () => undefined, projectHistory as never, false, false);
  (host as unknown as { index: { byId(id: string): UiSession | undefined } }).index.byId =
    (id) => sessions.find((session) => session.id === id);
  return host;
}

function indexedThread(path: string): UiSession {
  return {
    id: SESSION_ID,
    path,
    title: "Index 3",
    modifiedAt: 0,
    projectPath: "/repo",
    projectName: "repo",
    messageCount: 2,
  };
}

describe("the transcript of a thread the host holds no runtime for", () => {
  it("is read from the session file the index names", async () => {
    const path = await sessionFile();
    const page = await hostWithIndex([indexedThread(path)]).loadTranscript(SESSION_ID);

    expect(page.sessionId).toBe(SESSION_ID);
    expect(page.messages.map((message) => message.text)).toEqual(["Report the index", "Index 3"]);
    expect(page.hasMore).toBe(false);
  });

  it("is refused only when nothing persisted answers for the thread", async () => {
    await expect(hostWithIndex([]).loadTranscript(SESSION_ID))
      .rejects.toThrow("That thread is not open any more.");
  });

  it("is refused for a thread another runtime backend owns", async () => {
    const path = await sessionFile();
    const external = { ...indexedThread(path), backendKind: "codex" as never };
    await expect(hostWithIndex([external]).loadTranscript(SESSION_ID))
      .rejects.toThrow("That thread is not open any more.");
  });
});
