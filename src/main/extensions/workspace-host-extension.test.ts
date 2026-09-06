import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceHostClient } from "../../shared/workspace-kit-protocol.js";
import { HostExtensionRegistry, type HostExtensionServices } from "../host-extensions.js";
import { createWorkspaceHostExtension } from "./workspace-host-extension.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function workspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tau-workspace-kit-"));
  directories.push(path);
  return path;
}

async function client(cwd: string) {
  const services: HostExtensionServices = {
    cwd: () => cwd,
    agentDir: "/agent",
    safeMode: false,
    log: () => undefined,
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    workspaceRef: (path: string) => ({ workspaceId: `ws1_${path}`, displayPath: path }),
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    findCommand: () => undefined,
    refreshExtensionPackages: async () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      start: async () => { throw new Error("no threads in this test"); },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    setPermissionLevel: () => undefined,
    registerRuntimeBackend: () => () => undefined,
    presentUi: () => () => undefined,
  };
  const registry = new HostExtensionRegistry(services, () => undefined);
  await registry.activate(createWorkspaceHostExtension());
  return createWorkspaceHostClient((command, input) => registry.invoke("tau.workspace", command, input));
}

describe("Workspace Kit host extension", () => {
  it("shows the .scratch directory and lets the viewer load its contents", async () => {
    const cwd = await workspace();
    await mkdir(join(cwd, ".scratch", "feature", "issues"), { recursive: true });
    await writeFile(join(cwd, ".scratch", "feature", "spec.md"), "# Spec\n");
    await mkdir(join(cwd, ".git"));
    const kit = await client(cwd);

    const root = await kit.getFileTree();
    expect(root.map((node) => node.name)).toContain(".scratch");
    expect(root.map((node) => node.name)).not.toContain(".git");

    const scratch = await kit.getFileTree(".scratch");
    expect(scratch).toEqual([expect.objectContaining({ name: "feature", kind: "directory", path: ".scratch/feature" })]);

    const feature = await kit.getFileTree(".scratch/feature");
    expect(feature.map((node) => node.path)).toEqual([".scratch/feature/issues", ".scratch/feature/spec.md"]);
  });

  it("reads files inside the workspace and refuses anything that leaves it", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "README.md"), "hello\n");
    const kit = await client(cwd);
    await expect(kit.readFile("README.md")).resolves.toMatchObject({ kind: "text", text: "hello\n" });
    // A relative reference cannot escape, and an absolute one is not a reference at all.
    await expect(kit.readFile("../outside.txt")).rejects.toThrow("Name a file by its path inside the workspace.");
    await expect(kit.readFile(join(cwd, "README.md"))).rejects.toThrow("Name a file by its path inside the workspace.");
  });

  it("refuses to browse a tree outside the workspace", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    await expect(kit.getFileTree("/")).rejects.toThrow("Name a file by its path inside the workspace.");
    await expect(kit.getFileTree("../..")).rejects.toThrow("Name a file by its path inside the workspace.");
  });

  it("validates command input before touching the workspace", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    await expect(kit.readFile("")).rejects.toThrow("Name a file by its path inside the workspace.");
    await expect(kit.openInEditor("")).rejects.toThrow('Workspace command needs "editorId".');
  });

  it("answers folder browsing with an identity for the folder a client would keep", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    const listing = await kit.listDirectories(cwd);
    expect(listing.workspace.workspaceId).toMatch(/^ws1_/u);
    expect(listing.workspace.displayPath).toBe(listing.path);
  });
});
