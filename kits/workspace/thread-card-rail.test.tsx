// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { DesktopExtension, UiSession } from "tau";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";
import { WORKSPACE_STORE_SERVICE, type ThreadCardSectionProps, type ThreadRailOrganizer, type WorkspaceStoreApi } from "./protocol.js";

afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); });

const sessions: UiSession[] = [
  { id: "one", path: "/sessions/one.jsonl", title: "First thread", modifiedAt: Date.now(), projectPath: "/projects/tau", projectName: "tau", projectLabel: "fix/card", messageCount: 2 },
  { id: "two", path: "/sessions/two.jsonl", title: "Second thread", modifiedAt: Date.now() - 1_000, projectPath: "/projects/tau", projectName: "tau", projectLabel: "main", messageCount: 2 },
];

function PullRequests({ session, Row }: ThreadCardSectionProps) {
  return <Row icon={<i />}>#7 Pull request of {session.title}</Row>;
}

/** jsdom lays out nothing, so the virtual main list draws no rows; a labelled section draws them all. */
const organizer: ThreadRailOrganizer = {
  subscribe: () => () => undefined,
  getVersion: () => 1,
  sections: (threads) => [{ id: "pinned", label: "Pinned", threads }, { id: "active", threads: [] }],
  menu: () => [],
  runMenu: () => undefined,
  toggleSettled: () => undefined,
  dropLabel: () => undefined,
  drop: () => undefined,
};

async function renderRail() {
  const contributing: DesktopExtension = {
    id: "test.card",
    name: "Card",
    activate: (context) => context.useService<WorkspaceStoreApi>(WORKSPACE_STORE_SERVICE, (store) => {
      const stops = [store.registerThreadRailOrganizer(organizer), store.registerThreadCardSection?.({ place: "section", Component: PullRequests })];
      return () => stops.forEach((stop) => stop?.());
    }),
  };
  const client = createFakeHostClient({
    bootstrap: async () => ({
      version: 1,
      threadIndex: { projects: [{ path: "/projects/tau", name: "tau", lastOpenedAt: 1 }], sessions },
      detail: { sessionId: "one", messages: [], isStreaming: false, activeTools: [] },
      catalog: { sessionId: "one", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: true },
      project: { cwd: "/projects/tau" },
    }),
    invokeHostExtension: workspaceHostStub(),
  });
  renderApp(client, { extensions: [workspaceExtension, contributing] });
  await screen.findByText("Second thread");
}

const rowButton = (title: string) => screen.getByText(title).closest("[data-rail-thread]")!.querySelector<HTMLElement>(".thread-main")!;

describe("a rail row's hover card", () => {
  it("replaces the row's text tooltip", async () => {
    await renderRail();
    const button = rowButton("Second thread");
    expect(button.hasAttribute("data-tooltip")).toBe(false);
    expect(button.querySelector("[data-tooltip]")).toBeNull();
  });

  it("opens on keyboard focus with the kits' sections, and Escape closes it", async () => {
    await renderRail();
    const button = rowButton("Second thread");
    act(() => {
      fireEvent.keyDown(document.body, { key: "Tab" });
      button.focus();
    });
    const card = await screen.findByRole("dialog", { name: "Thread details" });
    expect(card.querySelector(".thread-card-title")!.textContent).toBe("Second thread");
    expect(card.textContent).toContain("#7 Pull request of Second thread");
    expect(button.getAttribute("aria-describedby")).toBe(card.id);
    act(() => { fireEvent.keyDown(button, { key: "Escape" }); });
    expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
  });

  it("does not open when a row is focused by a click", async () => {
    await renderRail();
    const button = rowButton("First thread");
    act(() => {
      fireEvent.pointerDown(button);
      button.focus();
    });
    expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
  });
});
