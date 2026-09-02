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
    safeMode: false,
    log: () => undefined,
    openWorkspace: async () => ({ version: 1 as const, updates: [] }),
    knownWorkspacePath: async (path) => path,
    projectName: async () => "project",
    rememberProjectName: () => undefined,
    pickDirectory: async () => undefined,
    runtimeOwner: () => "tau" as const,
    thread: () => undefined,
    setThreadTitle: async () => undefined,
    attachedRuntime: () => undefined,
    describeProjects: () => () => undefined,
    noteSubprocess: () => undefined,
    sessions: {
      list: async () => [],
      open: () => { throw new Error("no sessions in this test"); },
      prepare: async () => { throw new Error("no sessions in this test"); },
      exclusive: (work) => work(),
      refreshIndex: async () => ({ version: 1 as const, type: "thread-index" as const, index: { projects: [], sessions: [] } }),
    },
    registerThreadLifecycle: () => () => undefined,
    registerTurnObserver: () => () => undefined,
    pinTranscriptEntries: () => () => undefined,
    decorateUiPrompt: () => () => undefined,
    registerRuntimeExtension: () => () => undefined,
    setPermissionPolicy: () => undefined,
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

    const scratch = await kit.getFileTree(join(cwd, ".scratch"));
    expect(scratch).toEqual([expect.objectContaining({ name: "feature", kind: "directory" })]);

    const feature = await kit.getFileTree(join(cwd, ".scratch", "feature"));
    expect(feature.map((node) => node.name)).toEqual(["issues", "spec.md"]);
  });

  it("reads files inside the workspace and refuses paths outside it", async () => {
    const cwd = await workspace();
    await writeFile(join(cwd, "README.md"), "hello\n");
    const kit = await client(cwd);
    await expect(kit.readFile("README.md")).resolves.toMatchObject({ kind: "text", text: "hello\n" });
    await expect(kit.readFile("../outside.txt")).rejects.toThrow("Path is outside the workspace.");
    await expect(kit.getFileTree("/")).rejects.toThrow("Path is outside the workspace.");
  });

  it("validates command input before touching the workspace", async () => {
    const cwd = await workspace();
    const kit = await client(cwd);
    await expect(kit.readFile("")).rejects.toThrow('Workspace command needs "path".');
    await expect(kit.openInEditor("")).rejects.toThrow('Workspace command needs "editorId".');
  });
});
