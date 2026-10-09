// @vitest-environment jsdom
import { act, cleanup, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import type { HostActionResult, ThreadDetail } from "../shared/host-protocol";
import type { WorkbenchActions } from "./extension-system";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const detail = (sessionId: string, text: string): ThreadDetail => ({
  sessionId, messages: [{ id: `${sessionId}-message`, role: "assistant", text, timestamp: 1 }], isStreaming: false, activeTools: [],
});

async function start() {
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: ["a", "b"].map((id) => ({ id, path: id, title: `Thread ${id}`, modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 })) },
      detail: detail("a", "Reply in A"),
      catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    switchSession: async (path): Promise<HostActionResult> => ({ version: 1, updates: [{ version: 1, type: "thread-detail", detail: detail(path, `Reply in ${path.toUpperCase()}`) }] }),
  });
  let actions: WorkbenchActions | undefined;
  renderApp(client, { extensions: [{ id: "test.view", name: "View", activate(context) {
    context.registerRegion({ id: "capture", placement: "composer-above", Component: (props) => { actions = props.actions; return null; } });
    context.registerConversationView?.({ id: "test.child", Component: ({ params, snapshot, onClose }) => <section aria-label="Child view">
      {String(params.child)} of {snapshot?.sessionId}<button type="button" onClick={onClose}>Back</button>
    </section> });
  } }] });
  await screen.findByText("Reply in A");
  await waitFor(() => expect(actions?.activeThread()?.sessionId).toBe("a"));
  return () => actions!;
}

it("shows a registered view in place of the transcript and composer until it closes", async () => {
  const actions = await start();
  act(() => actions().openConversationView?.("test.child", { child: "reviewer" }));
  expect((await screen.findByRole("region", { name: "Child view" })).textContent).toContain("reviewer of a");
  expect(screen.queryByText("Reply in A")).toBeNull();
  expect(document.querySelector(".conversation-column")?.classList.contains("conversation-view-active")).toBe(true);
  act(() => screen.getByRole("button", { name: "Back" }).click());
  await screen.findByText("Reply in A");
  expect(screen.queryByRole("region", { name: "Child view" })).toBeNull();
  expect(document.querySelector(".conversation-column")?.classList.contains("conversation-view-active")).toBe(false);
});

it("belongs to the thread it was opened on: another thread shows its own transcript, and so does coming back", async () => {
  const actions = await start();
  act(() => actions().openConversationView?.("test.child", { child: "reviewer" }));
  await screen.findByRole("region", { name: "Child view" });
  await act(async () => { await actions().switchSession("b"); });
  await screen.findByText("Reply in B");
  expect(screen.queryByRole("region", { name: "Child view" })).toBeNull();
  await act(async () => { await actions().switchSession("a"); });
  await screen.findByText("Reply in A");
  expect(screen.queryByRole("region", { name: "Child view" })).toBeNull();
});
