import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createWorkspaceHostExtension } from "../workspace/host.js";
import createFilesHostExtension from "./host.js";
import { createFilesHost, FILES_KIT_ID } from "./protocol.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function project(notes = "# Notes\n"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-files-host-"));
  roots.push(root);
  await writeFile(join(root, "notes.md"), notes);
  return root;
}

/** The host has `cwd` open; `known` are the other projects it admits. */
async function kits(cwd: string, known: readonly string[] = []) {
  const services: Partial<HostExtensionServices> = {
    cwd: () => cwd,
    knownWorkspacePath: async (path) => {
      if (path !== cwd && !known.includes(path)) throw new Error("Workspace is not a known Tau project.");
      return path;
    },
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    admitWorkspace: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    sessions: { list: async () => [] } as unknown as HostExtensionServices["sessions"],
  };
  const registry = await activateHostKit(createWorkspaceHostExtension(), services);
  await registry.activate(createFilesHostExtension() as unknown as HostExtension);
  return registry;
}

describe("Files Kit host", () => {
  it("reads, stats and writes through Workspace Kit, refusing a stale write", async () => {
    const cwd = await project();
    const registry = await kits(cwd);
    const host = createFilesHost((command, input) => registry.invoke(FILES_KIT_ID, command, input));

    const read = await host.read(cwd, "notes.md");
    expect(read).toMatchObject({ kind: "text", text: "# Notes\n" });
    await expect(host.stat(cwd, "notes.md")).resolves.toMatchObject({ exists: true, mtimeMs: read.mtimeMs });

    await expect(host.write(cwd, "notes.md", "# Mine\n", read.mtimeMs)).resolves.toMatchObject({ status: "written" });
    await expect(readFile(join(cwd, "notes.md"), "utf8")).resolves.toBe("# Mine\n");
    // The editor still thinks the file is as it first read it.
    await expect(host.write(cwd, "notes.md", "# Stale\n", (read.mtimeMs ?? 0) - 1_000)).resolves.toMatchObject({ status: "conflict" });
    await expect(readFile(join(cwd, "notes.md"), "utf8")).resolves.toBe("# Mine\n");
  });

  it("never writes outside the workspace", async () => {
    const cwd = await project();
    const registry = await kits(cwd);
    const host = createFilesHost((command, input) => registry.invoke(FILES_KIT_ID, command, input));
    await expect(host.write(cwd, "../escape.txt", "x")).rejects.toThrow(/inside the workspace/u);
    await expect(host.write(cwd, "/etc/hosts", "x")).rejects.toThrow(/inside the workspace/u);
  });

  it("reads and writes the project it names, not the one the host has open", async () => {
    const a = await project("# A\n");
    const b = await project("# B\n");
    const registry = await kits(a, [b]);
    const host = createFilesHost((command, input) => registry.invoke(FILES_KIT_ID, command, input));

    const read = await host.read(b, "notes.md");
    expect(read).toMatchObject({ text: "# B\n" });
    await expect(host.stat(b, "notes.md")).resolves.toMatchObject({ mtimeMs: read.mtimeMs });
    await expect(host.write(b, "notes.md", "# B, edited\n", read.mtimeMs)).resolves.toMatchObject({ status: "written" });

    await expect(readFile(join(b, "notes.md"), "utf8")).resolves.toBe("# B, edited\n");
    await expect(readFile(join(a, "notes.md"), "utf8")).resolves.toBe("# A\n");
  });

  it("refuses a write that names no project, or one the host does not know, and writes nothing", async () => {
    const a = await project("# A\n");
    const forgotten = await project("# Forgotten\n");
    const registry = await kits(a);
    const invoke = (command: string, input: unknown) => registry.invoke(FILES_KIT_ID, command, input);

    await expect(invoke("write", { relPath: "notes.md", text: "x" })).rejects.toThrow("Not saved: Tau does not know which project this file belongs to.");
    // Older and remote callers read without a project; they keep the host's.
    await expect(invoke("read", { relPath: "notes.md" })).resolves.toMatchObject({ text: "# A\n" });
    await expect(invoke("write", { workspace: forgotten, relPath: "notes.md", text: "x" })).rejects.toThrow("Not saved: This file's project is not open in Tau any more.");

    await expect(readFile(join(a, "notes.md"), "utf8")).resolves.toBe("# A\n");
    await expect(readFile(join(forgotten, "notes.md"), "utf8")).resolves.toBe("# Forgotten\n");
  });

  it("is the only other kit Workspace lets write a file", async () => {
    const cwd = await project();
    const registry = await kits(cwd);
    let denied: unknown;
    await registry.activate({
      id: "acme.other",
      name: "Other",
      activate: async (context) => {
        denied = await context.invokeHostExtension("tau.workspace", "write-file", { relPath: "notes.md", text: "x" }).catch((error: unknown) => error);
      },
    });
    expect(String(denied)).toMatch(/unauthori[sz]ed|not allowed|grant/iu);
    await expect(readFile(join(cwd, "notes.md"), "utf8")).resolves.toBe("# Notes\n");
  });
});
