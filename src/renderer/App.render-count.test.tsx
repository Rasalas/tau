// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient, type FakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";
import { loadTauApi } from "./runtime-extensions";
import { workspaceHostStub } from "./test-support/workspace-host-stub";
import { useWorkbench } from "./workbench-context";
import type { DesktopExtensionContext, DesktopExtension } from "./extension-system";

// App renders nothing but the workbench, so wrapping it counts App's own body.
const appRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./Workbench", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./Workbench")>();
  const Real = actual.Workbench;
  return {
    ...actual,
    Workbench: (props: { model: import("./Workbench").WorkbenchModel }) => {
      appRenders.count += 1;
      return <Real {...props} />;
    },
  };
});

// The thread header renders inside the workbench and outside the transcript.
const workbenchRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/ThreadHeader", () => ({
  ThreadHeader: () => {
    workbenchRenders.count += 1;
    return <header data-testid="title-bar" />;
  },
  StartDetails: () => null,
}));

// The composer sits beside the transcript; a flush of tool output leaves it alone too.
const composerRenders = vi.hoisted(() => ({ count: 0 }));
const transcriptRenders = vi.hoisted(() => ({ count: 0 }));
vi.mock("./components/TranscriptViewport", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/TranscriptViewport")>();
  const Real = actual.TranscriptViewport;
  return { ...actual, TranscriptViewport: (props: Parameters<typeof Real>[0]) => {
    transcriptRenders.count += 1;
    return <Real {...props} />;
  } };
});
vi.mock("./components/Composer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./components/Composer")>();
  const Real = actual.Composer;
  return {
    ...actual,
    Composer: (props: Parameters<typeof Real>[0]) => {
      composerRenders.count += 1;
      return <Real {...props} />;
    },
  };
});

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

async function renderLoadedApp(client: FakeHostClient, options?: Parameters<typeof renderApp>[1]) {
  // Module loading and the initial extension reconciliation are structural
  // renders. Complete them before measuring updates within an existing row.
  await loadTauApi();
  let view!: ReturnType<typeof renderApp>;
  await act(async () => { view = renderApp(client, options); });
  return view;
}

describe("app render isolation", () => {
  let client: FakeHostClient;

  beforeEach(() => {
    transcriptRenders.count = 0;
    appRenders.count = 0;
    workbenchRenders.count = 0;
    composerRenders.count = 0;
    client = createFakeHostClient({
      platform: "darwin",
      bootstrap: async () => ({
        version: 1,
        threadIndex: {
          projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }],
          sessions: [{ id: "session", path: "/session.jsonl", title: "Thread", modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 }],
        },
        detail: {
          sessionId: "session",
          messages: [{ id: "user-1", role: "user", text: "hello", timestamp: 1 }],
          isStreaming: false,
          activeTools: [],
          contextUsage: { tokens: 8000, contextWindow: 10000, percent: 80 },
        },
        catalog: { sessionId: "session", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
        project: { cwd: "/project" },
      }),
      invokeHostExtension: workspaceHostStub({
        listEditors: async () => [],
        getChanges: async () => ({ files: [], added: 0, removed: 0 }),
        getWorkspaceInfo: async () => ({ root: "/project", isRepo: false, isDirty: false, worktrees: [], refs: [] }),
        getFileTree: async () => [],
      }),
    });
    setHostClient(client);
  });

  it("opens and closes a drawer without rendering the transcript or composer again", async () => {
    const view = await renderLoadedApp(client, { extensions: [{ id: "layout", name: "Layout", activate(context) {
      context.registerPanel({ id: "probe", label: "Probe", placement: "drawer", Component: () => <span>Drawer content</span> });
      context.registerSidebar({ id: "controls", Component: ({ actions }) => <aside>
        <button onClick={() => actions.openPanel("probe")}>Open drawer</button>
        <button onClick={() => actions.closePanel?.("probe")}>Close drawer</button>
      </aside> });
    } }] });
    await screen.findByText("hello");
    await waitFor(() => expect(view.container.querySelector(".app-shell")?.getAttribute("data-startup-ready")).toBe("true"));
    const before = { composer: composerRenders.count, transcript: transcriptRenders.count };
    fireEvent.click(screen.getByRole("button", { name: "Open drawer" }));
    await screen.findByText("Drawer content");
    expect(composerRenders.count).toBe(before.composer);
    expect(transcriptRenders.count).toBe(before.transcript);
    fireEvent.click(screen.getByRole("button", { name: "Close drawer" }));
    await waitFor(() => expect(view.container.querySelector(".workbench-drawer")).toBeNull());
    expect(composerRenders.count).toBe(before.composer);
    expect(transcriptRenders.count).toBe(before.transcript);
  });

  it("isolates dynamic extension data from App and the composer while updating the active transcript", async () => {
    let context!: DesktopExtensionContext;
    let rows!: ReturnType<DesktopExtensionContext["registerTranscriptRows"]>;
    const view = await renderLoadedApp(client, { extensions: [{ id: "data", name: "Data", activate(given) {
      context = given;
      rows = given.registerTranscriptRows("data-rows");
    } }] });
    await screen.findByText("hello");
    const before = { app: appRenders.count, composer: composerRenders.count };
    act(() => {
      for (let index = 0; index < 50; index += 1) {
        context.setLiveStatus("other", `Waiting ${index}`);
        rows.setRows("other", [{ id: "other", content: <span>Other thread</span> }]);
      }
      context.setThreadRowStatuses({ other: { label: "Waiting" } });
      context.setThreadLineage({ parents: { other: "parent" }, workingChildren: {} });
      context.setProjectIcons({ "/project": "data:image/png;base64,a" });
      context.setProviderIcons({ custom: "data:image/png;base64,a" });
      context.setProblems([{ source: "Test", level: "warning", message: "A problem" }]);
    });
    expect(appRenders.count).toBe(before.app);
    expect(composerRenders.count).toBe(before.composer);
    expect(view.container.textContent).not.toContain("Other thread");
    act(() => rows.setRows("session", [{ id: "own", content: <span>Active extension row</span> }]));
    await screen.findByText("Active extension row");
    expect(appRenders.count).toBe(before.app);
    expect(composerRenders.count).toBe(before.composer);
    act(() => rows.clear("session"));
    expect(screen.queryByText("Active extension row")).toBeNull();
  });

  it("streams assistant text without re-rendering App, the workbench or the composer", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    try {
      const view = await renderLoadedApp(client);
      await screen.findByText("hello");
      await waitFor(() => expect(workbenchRenders.count).toBeGreaterThan(0));

      // The first delta opens a row, which is a structural change; the text
      // that follows it is not.
      act(() => client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: "streamed" }));
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed"));

      const appBefore = appRenders.count;
      const workbenchBefore = workbenchRenders.count;
      const composerBefore = composerRenders.count;
      act(() => {
        client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: " answer" });
        client.emit({ type: "assistant-thinking", sessionId: "session", id: "assistant-1", delta: "because" });
      });
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });

      await waitFor(() => expect(view.container.querySelector(".transcript")?.textContent ?? "").toContain("streamed answer"));
      expect(appRenders.count).toBe(appBefore);
      expect(workbenchRenders.count).toBe(workbenchBefore);
      expect(composerRenders.count).toBe(composerBefore);

      // The meter still updates when the estimate reaches its next displayed thousand.
      fireEvent.mouseEnter(screen.getByRole("button", { name: "Context 80 percent used" }).parentElement!);
      await waitFor(() => expect(screen.getByText("messages").closest("span")?.textContent).toBe("messages0"));
      act(() => client.emit({ type: "assistant-delta", sessionId: "session", id: "assistant-1", delta: "x".repeat(4000) }));
      act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      await waitFor(() => expect(screen.getByText("messages").closest("span")?.textContent).toBe("messages1k"));
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("streams tool output without re-rendering App or the workbench", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    const flushFrames = () => act(() => { frames.splice(0).forEach((frame) => frame(0)); });
    const transcriptText = (view: ReturnType<typeof renderApp>) => view.container.querySelector(".transcript")?.textContent ?? "";
    try {
      const view = await renderLoadedApp(client);
      await screen.findByText("hello");
      await waitFor(() => expect(workbenchRenders.count).toBeGreaterThan(0));

      // Starting a run and a tool are structural; the output that follows is not.
      act(() => {
        client.emit({ type: "agent-status", sessionId: "session", running: true });
        client.emit({
          type: "tool-start",
          sessionId: "session",
          tool: { id: "tool-1", name: "bash", args: { command: "for i in 1 2 3; do echo line-$i; done" }, status: "running", startedAt: 1 },
        });
      });
      act(() => client.emit({ type: "tool-update", sessionId: "session", id: "tool-1", output: "line-1\n" }));
      flushFrames();
      // The live row is folded; open it so the output is on screen.
      const liveLine = await waitFor(() => {
        const button = view.container.querySelector<HTMLButtonElement>(".work-live-line");
        if (!button) throw new Error("no live row yet");
        return button;
      });
      act(() => liveLine.click());
      await waitFor(() => expect(transcriptText(view)).toContain("line-1"));
      await waitFor(() => expect(view.container.querySelector(".send-button.stop")).not.toBeNull());

      const appBefore = appRenders.count;
      const workbenchBefore = workbenchRenders.count;
      const composerBefore = composerRenders.count;
      for (const output of ["line-1\nline-2\n", "line-1\nline-2\nline-3\n"]) {
        act(() => client.emit({ type: "tool-update", sessionId: "session", id: "tool-1", output }));
        flushFrames();
      }

      await waitFor(() => expect(transcriptText(view)).toContain("line-3"));
      expect(appRenders.count).toBe(appBefore);
      expect(workbenchRenders.count).toBe(workbenchBefore);
      expect(composerRenders.count).toBe(composerBefore);
    } finally {
      requestFrame.mockRestore();
    }
  });

  it("still hands a kit reading the workbench context each tool output", async () => {
    const frames: FrameRequestCallback[] = [];
    const requestFrame = vi.spyOn(window, "requestAnimationFrame")
      .mockImplementation((callback: FrameRequestCallback) => frames.push(callback));
    const ToolOutput = () => <output data-testid="kit-tools">{useWorkbench().tools.map((tool) => tool.output).join("")}</output>;
    const kit: DesktopExtension = {
      id: "test.tool-reader",
      name: "Tool reader",
      activate: (context) => { context.registerRegion({ id: "reader", placement: "transcript-footer", Component: ToolOutput }); },
    };
    try {
      await renderLoadedApp(client, { extensions: [kit] });
      await screen.findByText("hello");
      act(() => {
        client.emit({ type: "agent-status", sessionId: "session", running: true });
        client.emit({ type: "tool-start", sessionId: "session", tool: { id: "tool-1", name: "bash", args: {}, status: "running", startedAt: 1 } });
      });
      for (const output of ["first", "first second"]) {
        act(() => client.emit({ type: "tool-update", sessionId: "session", id: "tool-1", output }));
        act(() => { frames.splice(0).forEach((frame) => frame(0)); });
      }
      await waitFor(() => expect(screen.getByTestId("kit-tools").textContent).toBe("first second"));
    } finally {
      requestFrame.mockRestore();
    }
  });
});
