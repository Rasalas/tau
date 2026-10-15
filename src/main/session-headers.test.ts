import { appendFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionHeaderIndex } from "./session-headers.js";

const roots: string[] = [];
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-session-headers-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function session(id: string, cwd = "/repo"): string {
  return JSON.stringify({ type: "session", version: 3, id, cwd, timestamp: "2026-10-12T10:00:00Z" }) + "\n";
}
function message(id: string): string {
  return JSON.stringify({ type: "message", id, parentId: null, timestamp: "2026-10-12T10:00:01Z", message: { role: "user", content: [{ type: "text", text: id }], timestamp: 1 } }) + "\n";
}

describe("SessionHeaderIndex", () => {
  it("lists what SessionManager.listAll lists, without reading past the header", async () => {
    const root = await directory();
    await writeFile(join(root, "a.jsonl"), session("a", "/one") + message("m1"));
    await writeFile(join(root, "b.jsonl"), "\n{not json\n" + session("b", "/two"));
    await writeFile(join(root, "c.jsonl"), message("orphan") + session("c"));
    await writeFile(join(root, "d.jsonl"), "");
    await writeFile(join(root, "e.txt"), session("e"));
    await writeFile(join(root, "f.jsonl"), JSON.stringify({ type: "session", version: 3, id: "f" }));
    const expected = (await SessionManager.listAll(root)).map((info) => ({ sessionId: info.id, path: info.path, cwd: info.cwd }));

    const listed = await new SessionHeaderIndex(root).list();

    expect(listed).toEqual(expect.arrayContaining(expected));
    expect(listed).toHaveLength(expected.length);
  });

  it("reads the per-project folders of Pi's own layout", async () => {
    const agentDir = await directory();
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    await mkdir(join(agentDir, "sessions", "--repo--"), { recursive: true });
    await writeFile(join(agentDir, "sessions", "--repo--", "a.jsonl"), session("a"));
    await writeFile(join(agentDir, "sessions", "stray.jsonl"), session("stray"));

    expect(await new SessionHeaderIndex(undefined).list()).toEqual([
      { sessionId: "a", path: join(agentDir, "sessions", "--repo--", "a.jsonl"), cwd: "/repo" },
    ]);
  });

  it("follows a rewritten file and forgets a removed one", async () => {
    const root = await directory();
    const path = join(root, "a.jsonl");
    await writeFile(path, session("a"));
    const index = new SessionHeaderIndex(root);
    expect(await index.list()).toEqual([{ sessionId: "a", path, cwd: "/repo" }]);

    await appendFile(path, message("m1"));
    expect(await index.list()).toEqual([{ sessionId: "a", path, cwd: "/repo" }]);
    await writeFile(path, session("b", "/elsewhere"));
    expect(await index.list()).toEqual([{ sessionId: "b", path, cwd: "/elsewhere" }]);
    await rm(path);
    expect(await index.list()).toEqual([]);
  });

  it("lists the most recently written sessions first", async () => {
    const root = await directory();
    await writeFile(join(root, "old.jsonl"), session("old"));
    await writeFile(join(root, "new.jsonl"), session("new"));
    await utimes(join(root, "old.jsonl"), new Date(1_000), new Date(1_000));

    expect((await new SessionHeaderIndex(root).list()).map((entry) => entry.sessionId)).toEqual(["new", "old"]);
  });
});
