// @vitest-environment jsdom
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtension, HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createWorkspaceHostExtension } from "../workspace/host.js";
import createFilesHostExtension from "./host.js";
import { createFilesHost, FILES_KIT_ID } from "./protocol.js";
import { createCodeEditor } from "./editor-view.js";
import { DOCX, zipFixture } from "./preview-fixtures.js";
import { FileDocument } from "./document.js";

Range.prototype.getClientRects ??= function getClientRects() { return [] as unknown as DOMRectList; };
Range.prototype.getBoundingClientRect ??= function getBoundingClientRect() { return new DOMRect(); };

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
  it("previews only a named admitted project and never the host's current project", async () => {
    const a = await project(); const b = await project(); const forgotten = await project();
    await writeFile(join(b, "a.docx"), zipFixture(DOCX));
    const registry = await kits(a, [b]);
    const invoke = (command: string, input: unknown) => registry.invoke(FILES_KIT_ID, command, input);
    await expect(invoke("preview", { workspace: b, relPath: "a.docx" })).resolves.toMatchObject({ ok: true, content: { kind: "document" } });
    await expect(invoke("preview", { relPath: "a.docx" })).rejects.toThrow("Tau does not know which project");
    await expect(invoke("preview", { workspace: forgotten, relPath: "a.docx" })).rejects.toThrow("not a known Tau project");
    expect(await invoke("preview", { workspace: b, relPath: "../outside.docx" })).toMatchObject({ ok: false });
  });

  it("opens a CRLF file, edits one line and saves a one-line diff", async () => {
    const original = "first\r\nsecond\r\nthird\r\n";
    const cwd = await project(original);
    await writeFile(join(cwd, "before.md"), original);
    const registry = await kits(cwd);
    const host = createFilesHost((command, input) => registry.invoke(FILES_KIT_ID, command, input));
    const document = new FileDocument("notes.md", {
      read: (path) => host.read(cwd, path),
      stat: (path) => host.stat(cwd, path),
      write: (path, text, mtime) => host.write(cwd, path, text, mtime),
    });
    await document.load();
    const editor = createCodeEditor(globalThis.document.createElement("div"), {
      text: document.getState().text, path: "notes.md", label: "Notes", readOnly: false, wrap: false, mac: false,
      callbacks: { onChange: (text) => document.edit(text) },
    });
    try {
      const line = editor.view.state.doc.line(2);
      editor.view.dispatch({ changes: { from: line.from, to: line.to, insert: "changed" } });
      expect(await document.save()).toBe(true);
      await expect(readFile(join(cwd, "notes.md"), "utf8")).resolves.toBe("first\r\nchanged\r\nthird\r\n");
      const diff = spawnSync("git", ["diff", "--no-index", "--numstat", "--", "before.md", "notes.md"], { cwd, encoding: "utf8" });
      expect(diff.status).toBe(1);
      expect(diff.stdout).toMatch(/^1\t1\t/u);
    } finally {
      editor.destroy();
      document.dispose();
    }
  });

  it("opens non-UTF-8 without allowing edits or saves", async () => {
    const cwd = await project();
    const bytes = Buffer.from("Grüße\n", "latin1");
    await writeFile(join(cwd, "notes.md"), bytes);
    const registry = await kits(cwd);
    const host = createFilesHost((command, input) => registry.invoke(FILES_KIT_ID, command, input));
    const document = new FileDocument("notes.md", {
      read: (path) => host.read(cwd, path), stat: (path) => host.stat(cwd, path),
      write: (path, text, mtime) => host.write(cwd, path, text, mtime),
    });
    await document.load();
    expect(document.getState()).toMatchObject({ status: "ready", editable: false });
    document.edit("changed");
    await document.save();
    await expect(readFile(join(cwd, "notes.md"))).resolves.toEqual(bytes);
    document.dispose();
  });

  it("adopts the line separator on reload without echoing an edit", () => {
    const changes: string[] = [];
    const editor = createCodeEditor(document.createElement("div"), {
      text: "first\nsecond\n", path: "notes.txt", label: "Notes", readOnly: false, wrap: false, mac: false,
      callbacks: { onChange: (text) => changes.push(text) },
    });
    try {
      for (const separator of ["\r\n", "\r", "\n"]) {
        editor.setText(`first${separator}second${separator}`);
        expect(changes).toEqual([]);
        const line = editor.view.state.doc.line(2);
        editor.view.dispatch({ changes: { from: line.from, to: line.to, insert: `changed${separator}new` } });
        expect(changes.splice(0)).toEqual([`first${separator}changed${separator}new${separator}`]);
      }
    } finally {
      editor.destroy();
    }
  });

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
