import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fakeAgent, until } from "./fake.js";
import { AcpAgentSession } from "./session.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "tau-acp-files-"));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const cwd = join(directory, "workspace");
  const outside = join(directory, "outside");
  await mkdir(cwd);
  await mkdir(outside);
  const agent = fakeAgent();
  agent.respond("initialize", () => ({ protocolVersion: 1 }));
  agent.respond("session/new", () => ({ sessionId: "session" }));
  const session = new AcpAgentSession({
    agentName: "Test runtime", process: agent.process, cwd,
    clientInfo: { name: "tau", version: "1" }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    onUpdate: () => undefined, onPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  });
  cleanups.push(() => session.close());
  await session.initialize();
  await session.newSession();
  let nextId = 100;
  const request = async (method: string, path: string) => {
    const id = nextId++;
    agent.send({ jsonrpc: "2.0", id, method, params: { sessionId: "session", path, content: "changed" } });
    await until(() => agent.received.some((message) => message.id === id));
    return agent.received.find((message) => message.id === id)!;
  };
  return { cwd, outside, request };
}

describe("ACP workspace file containment", () => {
  it("refuses reads and writes through a file link outside the workspace", async () => {
    const { cwd, outside, request } = await fixture();
    const target = join(outside, "private.txt");
    await writeFile(target, "private");
    await symlink(target, join(cwd, "linked.txt"));
    for (const method of ["fs/read_text_file", "fs/write_text_file"]) {
      expect(await request(method, "linked.txt")).toMatchObject({ error: { code: -32602 } });
    }
    expect(await readFile(target, "utf8")).toBe("private");
  });

  it("refuses dangling file and directory links without creating their targets", async () => {
    const { cwd, outside, request } = await fixture();
    await symlink(join(outside, "missing.txt"), join(cwd, "dangling.txt"));
    await symlink(join(outside, "missing-dir"), join(cwd, "dangling-dir"), "dir");
    for (const path of ["dangling.txt", "dangling-dir/nested/file.txt"]) {
      expect(await request("fs/write_text_file", path)).toHaveProperty("error");
    }
    await expect(readFile(join(outside, "missing.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(outside, "missing-dir/nested/file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses missing descendants of an existing linked outside directory", async () => {
    const { cwd, outside, request } = await fixture();
    await symlink(outside, join(cwd, "linked-dir"), "dir");
    expect(await request("fs/write_text_file", "linked-dir/new/deep/file.txt")).toMatchObject({ error: { code: -32602 } });
    await expect(readFile(join(outside, "new/deep/file.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("allows existing internal links and new nested workspace files", async () => {
    const { cwd, request } = await fixture();
    await writeFile(join(cwd, "target.txt"), "original");
    await symlink("target.txt", join(cwd, "linked.txt"));
    expect(await request("fs/read_text_file", "linked.txt")).toMatchObject({ result: { content: "original" } });
    expect(await request("fs/write_text_file", "linked.txt")).toMatchObject({ result: {} });
    expect(await readFile(join(cwd, "target.txt"), "utf8")).toBe("changed");
    expect(await request("fs/write_text_file", "new/deep/file.txt")).toMatchObject({ result: {} });
    expect(await readFile(join(cwd, "new/deep/file.txt"), "utf8")).toBe("changed");
  });
});
