// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { UiMessage } from "../shared/contracts";
import type { HostActionResult, ThreadDetail } from "../shared/host-protocol";
import type { DesktopExtension } from "./extension-system";
import { setHostClient } from "./host-client-context";
import { setClientStorage } from "../workbench/client-storage";
import { createFakeHostClient } from "./test-support/fake-host-client";
import { renderApp } from "./test-support/render-app";

beforeEach(() => { vi.spyOn(console, "error").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); setHostClient(undefined); setClientStorage(undefined); });

/** A row the host sent in a shape the transcript does not draw: a notice whose text is an object. */
const unexpected = { id: "odd", role: "notice", text: { unexpected: true }, timestamp: 1 } as unknown as UiMessage;
const detail = (sessionId: string, messages: UiMessage[]): ThreadDetail => ({ sessionId, messages, isStreaming: false, activeTools: [] });
const update = (value: ThreadDetail): HostActionResult => ({ version: 1, updates: [{ version: 1, type: "thread-detail", detail: value }] });
const answer = (id: string, text: string): UiMessage => ({ id, role: "assistant", text, timestamp: 1 });

const threads: DesktopExtension = {
  id: "test.threads",
  name: "Threads",
  activate(plugin) {
    plugin.registerSidebar({ id: "threads", Component: ({ actions }) => <button type="button" onClick={() => void actions.switchSession("b")}>Open thread b</button> });
  },
};

function start(copyText = vi.fn(async (_text: string) => undefined)) {
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [], sessions: ["a", "b"].map((id) => ({ id, path: id, title: `Thread ${id}`, modifiedAt: 1, projectPath: "/project", projectName: "project", messageCount: 1 })) },
      detail: detail("a", [unexpected]),
      catalog: { models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0 },
      project: { cwd: "/project" },
    }),
    switchSession: async (path) => update(detail(path, [answer(`${path}-answer`, `Answer in ${path}`)])),
    copyText,
  });
  renderApp(client, { extensions: [threads] });
  return { client, copyText };
}

it("keeps the sidebar when a transcript row throws, and another thread opens from it", async () => {
  start();
  const card = await screen.findByRole("alert");
  expect(card.textContent).toContain("Something went wrong.");
  // In the conversation column, beside the sidebar and not in its place.
  expect(card.closest("main.conversation-column")).not.toBeNull();
  expect(card.closest(".sidebar-slot")).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Open thread b" }));
  expect(await screen.findByText("Answer in b")).not.toBeNull();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  expect(screen.getByRole("button", { name: "Open thread b" })).not.toBeNull();
});

it("draws the thread again on Try again once the host sends a row it can draw", async () => {
  const { client } = start();
  await screen.findByRole("alert");
  act(() => { client.emit({ type: "host-update", update: { version: 1, type: "thread-detail", detail: detail("a", [answer("fixed", "Answer in a")]) } }); });
  // The card stays until the user asks: the update alone does not hide it.
  expect(screen.getByRole("alert")).not.toBeNull();

  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(await screen.findByText("Answer in a")).not.toBeNull();
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
});

it("copies a report of the failed row", async () => {
  const { copyText } = start();
  await screen.findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "Copy error" }));
  expect(await screen.findByRole("button", { name: "Copied" })).not.toBeNull();
  expect(copyText.mock.calls[0]![0]).toContain("Tau render error (conversation)");
});
