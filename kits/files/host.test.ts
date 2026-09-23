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

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tau-files-host-"));
  roots.push(root);
  await writeFile(join(root, "notes.md"), "# Notes\n");
  return root;
}

async function kits(cwd: string) {
  const services: Partial<HostExtensionServices> = {
    cwd: () => cwd,
    knownWorkspacePath: async (path) => path,
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

    const read = await host.read("notes.md");
    expect(read).toMatchObject({ kind: "text", text: "# Notes\n" });
    await expect(host.stat("notes.md")).resolves.toMatchObject({ exists: true, mtimeMs: read.mtimeMs });

    await expect(host.write("notes.md", "# Mine\n", read.mtimeMs)).resolves.toMatchObject({ status: "written" });
    await expect(readFile(join(cwd, "notes.md"), "utf8")).resolves.toBe("# Mine\n");
    // The editor still thinks the file is as it first read it.
    await expect(host.write("notes.md", "# Stale\n", (read.mtimeMs ?? 0) - 1_000)).resolves.toMatchObject({ status: "conflict" });
    await expect(readFile(join(cwd, "notes.md"), "utf8")).resolves.toBe("# Mine\n");
  });

  it("never writes outside the workspace", async () => {
    const cwd = await project();
    const registry = await kits(cwd);
    const host = createFilesHost((command, input) => registry.invoke(FILES_KIT_ID, command, input));
    await expect(host.write("../escape.txt", "x")).rejects.toThrow(/inside the workspace/u);
    await expect(host.write("/etc/hosts", "x")).rejects.toThrow(/inside the workspace/u);
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
