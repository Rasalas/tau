// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiEnvironments, WorkbenchActions } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { PreferencesStore, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { EditorPlacement, type EditorWindowMachines } from "./editor-placement.js";
import type { EditorTarget, WorkspaceHostClient } from "./protocol.js";
import { WorkspaceStore } from "./store.js";

const LOCAL = "local-host-id";
const STUDIO = "studio-host-id";

afterEach(() => { setHostClient(undefined); vi.restoreAllMocks(); });

/** A desktop window on LOCAL whose page shows `shown`, over a host whose files are local when it is LOCAL. */
function windowStore(options: { shown?: string; target?: EditorTarget; localEditors?: Array<{ id: string; name: string; unsupported?: string }> } = {}) {
  const shown = options.shown ?? LOCAL;
  setHostClient(createFakeHostClient({ hasCapability: (capability: string) => capability !== "local-files" || shown === LOCAL }));
  const target = options.target ?? { root: "/home/me/p", isFile: false, platform: "posix", machine: { id: STUDIO, name: "Studio" } };
  const host = {
    editorTarget: vi.fn(async (relPath?: string) => relPath ? { ...target, path: `${target.root}/${relPath}`, isFile: true } : target),
    listEditors: vi.fn(async () => [{ id: "code", name: "VS Code" }]),
    openInEditor: vi.fn(async () => undefined),
  } as unknown as WorkspaceHostClient & { editorTarget: ReturnType<typeof vi.fn>; listEditors: ReturnType<typeof vi.fn>; openInEditor: ReturnType<typeof vi.fn> };
  const local = vi.fn(async (command: string, _input?: unknown): Promise<unknown> => {
    if (command === "editor-machines") return {};
    if (command === "remote-editors") return options.localEditors ?? [{ id: "subl", name: "Sublime Text", unsupported: "Sublime Text cannot open a folder on another machine." }, { id: "cursor", name: "Cursor" }];
    return undefined;
  });
  const snapshot: UiEnvironments = {
    shown,
    environments: [
      { id: LOCAL, name: "Laptop", local: true, status: "connected", threads: [], threadCount: 0, projects: [] },
      { id: STUDIO, name: "Studio", local: false, status: "connected", route: { kind: "ssh", target: "me@studio" }, threads: [], threadCount: 0, projects: [] },
    ],
    secureStorage: true,
  };
  const machines: EditorWindowMachines = {
    ...(shown !== LOCAL ? { shownElsewhere: shown } : {}),
    getSnapshot: () => snapshot,
    subscribe: () => () => undefined,
    invokeExtension: (_machine, _extension, command, input) => local(command, input),
  };
  const store = new WorkspaceStore(new PreferencesStore(), host);
  const notify = vi.fn();
  store.bind({ notify } as unknown as WorkbenchActions);
  store.setEditorPlacement(new EditorPlacement(host, (command, input) => local(command, input), machines), machines);
  store.update({ cwd: "/home/me/p", workspaceId: "ws1_studio" });
  return { store, host, local, notify };
}

describe("Workspace Kit editors for another machine's project", () => {
  it("offers this device's editors for a project of another machine, the first that can open it chosen", async () => {
    const { store, host } = windowStore();
    await store.loadEditors();
    expect(host.listEditors).not.toHaveBeenCalled();
    expect(store.getSnapshot().editorRemote).toEqual({ machine: STUDIO, name: "Studio", location: { kind: "ssh", destination: "me@studio" }, source: "tau-ssh" });
    expect(store.activeEditor()?.id).toBe("cursor");
    expect(store.editorsHere()).toBe(true);
  });

  it("opens a file at its line through the window machine's host, while the page shows the other machine", async () => {
    const { store, local, host } = windowStore({ shown: STUDIO });
    await store.loadEditors();
    expect(store.editorsHere()).toBe(true);
    await store.openInEditor("src/a.ts", undefined, { line: 3 });
    expect(host.openInEditor).not.toHaveBeenCalled();
    expect(local).toHaveBeenLastCalledWith("open-remote-editor", {
      editorId: "cursor", location: { kind: "ssh", destination: "me@studio" }, root: "/home/me/p", path: "/home/me/p/src/a.ts", platform: "posix", line: 3,
    });
  });

  it("keeps a project of the window's own machine on the host's own editors", async () => {
    const { store, host, local } = windowStore({ target: { root: "/p", isFile: false, platform: "posix", machine: { id: LOCAL, name: "Laptop" } } });
    await store.loadEditors();
    expect(store.getSnapshot().editors).toEqual([{ id: "code", name: "VS Code" }]);
    expect(store.getSnapshot().editorRemote).toBeUndefined();
    await store.openInEditor(undefined, "code");
    expect(host.openInEditor).toHaveBeenCalledWith("code", undefined, "ws1_studio", undefined);
    expect(local).not.toHaveBeenCalledWith("open-remote-editor", expect.anything());
  });

  it("says why nothing opens when no editor of this device reaches the other machine", async () => {
    const { store, notify, local } = windowStore({ localEditors: [{ id: "subl", name: "Sublime Text", unsupported: "Sublime Text cannot open a folder on another machine." }] });
    await store.loadEditors();
    expect(store.activeEditor()).toBeUndefined();
    await store.openInEditor();
    expect(notify).toHaveBeenCalledWith("No editor on this device opens a project of Studio.");
    expect(local).not.toHaveBeenCalledWith("open-remote-editor", expect.anything());
  });
});

describe("editorButtonLabel", () => {
  it("names the SSH destination, or why no editor opens the project", async () => {
    const { editorButtonLabel } = await import("./title.js");
    const remote = { machine: STUDIO, name: "Studio", location: { kind: "ssh" as const, destination: "me@studio" } };
    expect(editorButtonLabel({ editors: [], editorRemote: remote }, { name: "Cursor" })).toBe("Open in Cursor on Studio over SSH (me@studio)");
    expect(editorButtonLabel({ editors: [], editorRemote: { machine: STUDIO, name: "Studio", problem: "Studio is reached through Tau Connect." } })).toBe("Studio is reached through Tau Connect.");
    expect(editorButtonLabel({ editors: [{ id: "subl", name: "Sublime Text", unsupported: "no" }], editorRemote: remote })).toBe("No editor on this device opens a project of Studio");
    expect(editorButtonLabel({ editors: [] }, { name: "Zed" })).toBe("Open in Zed");
  });
});
