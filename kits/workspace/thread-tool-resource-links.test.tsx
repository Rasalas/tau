// @vitest-environment jsdom
import { cleanup, fireEvent, screen, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiToolRun } from "../../src/shared/contracts";
import { ExtensionRegistry } from "../../src/renderer/extension-system";
import { WorkbenchContext, ThreadStoreContext, type WorkbenchContextValue } from "../../src/renderer/workbench-context";
import { WorkspaceResourceProvider, bindWorkspaceFileLoader } from "../../src/renderer/workspace-resource-context";
import { ThreadDocument } from "../../src/renderer/components/ThreadDocument";
import { RemoteThreadDocument } from "../../src/renderer/components/RemoteThreadDocument";
import { ToolRun } from "../../src/renderer/components/ToolRun";
import { TestProviders } from "../../src/renderer/test-support/test-providers";
import { ThreadStore } from "../../src/workbench/thread-store";
import { PlatformProvider } from "../../src/renderer/platform-context";
import type { Platform } from "../../src/workbench/platform";
import { presentRead } from "./tool-cards";

// Replace only virtual row placement. Providers, ToolRun and the registered source stay real.
vi.mock("../../src/renderer/components/VirtualTranscript", () => ({ VirtualTranscript: () => {
  return <ToolRun tool={fixture.tool} registry={fixture.registry} />;
} }));
const fixture = vi.hoisted(() => ({ tool: undefined as unknown as UiToolRun, registry: undefined as unknown as ExtensionRegistry }));
afterEach(cleanup);
const path = "src/same.ts";

describe("absolute tool links in historical transcripts", () => {
  it.each(["local", "peer"])("%s transcript uses its own announced display root, not the active thread", async (kind) => {
    const store = new ThreadStore();
    const sessionId = kind === "peer" ? "peer~history" : "history";
    store.applyThreadIndex({ projects: [], sessions: [{ id: sessionId, path: "/session", title: "History", workspaceId: "opaque-history", projectPath: "/legacy-history", projectDisplayPath: "/home-history", projectName: "History", modifiedAt: 1, messageCount: 1,
      ...(kind === "peer" ? { backendKind: "machine", machine: { id: "peer", name: "Peer" } } : {}) }] });
    fixture.tool = { id: "tool", name: "Read", args: { file_path: "/home-history/src/same.ts" }, status: "done", startedAt: 1, endedAt: 2 };
    fixture.registry = new ExtensionRegistry();
    const reads = vi.fn(async () => ({ path, name: "same.ts", size: 1, kind: "text" as const, text: "history file" }));
    const state = { changes: { files: [], added: 0, removed: 0 } };
    const source = { id: "documents", loadFile: reads, loadDiff: async (relative: string) => ({ path: relative, added: 0, removed: 0, hunks: [] }), getState: () => state, subscribe: () => () => undefined, openInEditor: () => undefined };
    fixture.registry.activate({ id: "test.history", name: "History", activate(plugin) {
      plugin.registerDocumentSource(source);
      plugin.registerToolRenderer("read", (tool) => tool.name === "Read", presentRead);
    } });
    const open = vi.fn((relative, origin) => { void bindWorkspaceFileLoader(source, origin)(relative); });
    const context: WorkbenchContextValue = { registry: fixture.registry, tools: [], events: [], openFile: vi.fn(), openWorkspaceFile: open, applySnapshot: vi.fn(), handleHostEvent: vi.fn() };
    const platform = { environments: {
      getSnapshot: () => ({ shown: "local", secureStorage: false, environments: [] }), subscribe: () => () => undefined,
      watchThread: (_machine: string, _session: string, listener: (view: unknown) => void) => {
        queueMicrotask(() => listener({ machine: "peer", sessionId: "history", machineName: "Peer", status: "connected", indexed: true, revision: 1, thread: { title: "Peer", path: "/session", projectName: "History", modifiedAt: 1, messageCount: 1, running: false } }));
        return () => undefined;
      }, transcriptPage: async () => ({ sessionId: "history", messages: [{ id: "answer", role: "assistant", text: "answer", timestamp: 1 }], hasMore: false }),
    } } as unknown as Platform;
    render(<TestProviders><PlatformProvider platform={platform}><ThreadStoreContext.Provider value={store}><WorkbenchContext.Provider value={context}>
      <WorkspaceResourceProvider sessionId="active" workspace="opaque-active" displayPath="/active">
        {kind === "local" ? <ThreadDocument sessionId="history" loadThread={async () => [{ id: "answer", role: "assistant", text: "answer", timestamp: 1 }]} onTakeOver={() => undefined} /> : <RemoteThreadDocument machine="peer" sessionId="history" />}
      </WorkspaceResourceProvider>
    </WorkbenchContext.Provider></ThreadStoreContext.Provider></PlatformProvider></TestProviders>);
    fireEvent.click(await screen.findByRole("button", { name: "Open /home-history/src/same.ts" }));
    await waitFor(() => expect(reads).toHaveBeenCalledWith(path, { workspace: "opaque-history" }));
    expect(open).toHaveBeenCalledWith(path, { sessionId, workspace: "opaque-history", sourceId: "documents" });
  });
});
