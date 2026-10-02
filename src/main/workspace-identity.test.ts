import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isWorkspaceId, isWorkspaceRelativePath } from "../shared/workspace-identity.js";
import { WorkspaceIdentity, readOrCreateHostId } from "./workspace-identity.js";

describe("workspace identity", () => {
  let directory: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "tau-workspace-identity-"));
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("keeps one host id across reads and creates it on first use", async () => {
    const path = join(directory, "state", "host-id");
    const first = readOrCreateHostId(path);
    expect(first).toMatch(/^[0-9a-f]{32}$/u);
    expect(await readFile(path, "utf8")).toBe(`${first}\n`);
    expect(readOrCreateHostId(path)).toBe(first);
  });

  it.each([
    "0123456789abcdef0123456789abcdef",
    "0123456789ABCDEF0123456789ABCDEF",
  ])("preserves a valid saved host id %s", async (hostId) => {
    const path = join(directory, "host-id");
    const contents = `${hostId}\n`;
    await writeFile(path, contents);

    expect(readOrCreateHostId(path)).toBe(hostId);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it.each([
    "0123456789abcdef0123456789abcdef~rex",
    "0123456789abcdef0123456789abcde~",
    "0123456789abcdef0123456789abcdef0",
    "0123456789abcdef",
    "0123456789abcdef0123456789abcdeg",
    "",
  ])("rejects an invalid saved host id %s without replacing it", async (hostId) => {
    const path = join(directory, "host-id");
    const contents = `${hostId}\n`;
    await writeFile(path, contents);

    expect(() => readOrCreateHostId(path)).toThrow(/must contain exactly 32 hexadecimal characters/u);
    expect(await readFile(path, "utf8")).toBe(contents);
  });

  it("mints an opaque id that carries neither the path nor the host id", () => {
    const identity = new WorkspaceIdentity("host-secret");
    const ref = identity.ref("/Users/me/work/tau");
    expect(isWorkspaceId(ref.workspaceId)).toBe(true);
    expect(ref.workspaceId).not.toContain("tau");
    expect(ref.workspaceId).not.toContain("host-secret");
    expect(ref.displayPath).toBe("/Users/me/work/tau");
  });

  it("gives the same workspace the same id on every host run", () => {
    const first = new WorkspaceIdentity("stable").workspaceId("/Users/me/work/tau");
    expect(new WorkspaceIdentity("stable").workspaceId("/Users/me/work/tau")).toBe(first);
    expect(new WorkspaceIdentity("other").workspaceId("/Users/me/work/tau")).not.toBe(first);
  });

  it("resolves only ids it minted itself", () => {
    const identity = new WorkspaceIdentity("stable");
    const { workspaceId } = identity.ref("/Users/me/work/tau");
    expect(identity.pathFor(workspaceId)).toBe("/Users/me/work/tau");
    expect(() => identity.pathFor("ws1_unknown")).toThrow(/does not know that workspace/u);
  });

  it("passes a path through for a client that does not speak identities yet", () => {
    expect(new WorkspaceIdentity("stable").pathFor("/Users/me/work/tau")).toBe("/Users/me/work/tau");
  });

  it("gives a symlinked path the id of the directory it points at", async () => {
    const link = join(directory, "link");
    await symlink(directory, link);
    const identity = new WorkspaceIdentity("stable");
    const canonical = await identity.learn(link);
    expect(identity.workspaceId(link)).toBe(identity.workspaceId(canonical));
    expect(identity.pathFor(identity.workspaceId(link))).toBe(resolve(canonical));
  });

  it("accepts workspace-relative paths and refuses escapes", () => {
    expect(isWorkspaceRelativePath("src/main/index.ts")).toBe(true);
    expect(isWorkspaceRelativePath("a/../b")).toBe(false);
    expect(isWorkspaceRelativePath("../secrets")).toBe(false);
    expect(isWorkspaceRelativePath("/etc/passwd")).toBe(false);
    expect(isWorkspaceRelativePath("C:/Windows")).toBe(false);
    // Separators on a Windows host.
    expect(isWorkspaceRelativePath("a\\..\\..\\secrets")).toBe(false);
    expect(isWorkspaceRelativePath("\\\\server\\share")).toBe(false);
    expect(isWorkspaceRelativePath("")).toBe(false);
  });
});
