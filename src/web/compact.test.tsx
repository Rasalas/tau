// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HostEvent, UiSession } from "../shared/contracts";
import { setHostClient } from "../renderer/host-client-context";
import { createFakeHostClient, type FakeHostClient } from "../renderer/test-support/fake-host-client";
import { createRendererServices } from "../renderer/renderer-services";
import { createMemoryStorage, setClientStorage } from "../workbench/client-storage";
import { WebWorkbench, webClientEnvironment } from "./WebWorkbench";

/** A phone-sized viewport, which is what makes the layout compact. */
function setViewport(width: number): void {
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true, writable: true });
  window.dispatchEvent(new Event("resize"));
}

function thread(id: string, title: string, modifiedAt: number): UiSession {
  return { id, path: `/sessions/${id}.json`, title, modifiedAt, projectPath: "/project", projectName: "project", messageCount: 2 };
}

const THREADS = [thread("t-a", "Rename the store", 30), thread("t-b", "Ship the web client", 20), thread("t-c", "Fix the flaky test", 10)];

function bootstrapWith(sessions: UiSession[]) {
  return async () => ({
    version: 1 as const,
    threadIndex: { projects: [{ path: "/project", name: "project", lastOpenedAt: 1 }], sessions },
    detail: { sessionId: "t-a", messages: [], isStreaming: false, activeTools: [] },
    catalog: { sessionId: "t-a", models: [], thinkingLevel: "off", thinkingLevels: ["off"], allTools: [], extensionCount: 0, supportsImageInput: false },
    project: { cwd: "/project" },
  });
}

function renderCompactClient(overrides: Parameters<typeof createFakeHostClient>[0] = {}): FakeHostClient {
  const client = createFakeHostClient({ bootstrap: bootstrapWith(THREADS), ...overrides });
  const storage = createMemoryStorage();
  setHostClient(client);
  setClientStorage(storage);
  render(<WebWorkbench
    client={client}
    storage={storage}
    services={createRendererServices()}
    environment={webClientEnvironment("compact")}
  />);
  return client;
}

const running = (sessionId: string): HostEvent => ({ type: "agent-status", sessionId, running: true });

beforeEach(() => setViewport(400));
afterEach(() => { cleanup(); setHostClient(undefined); setClientStorage(undefined); setViewport(1024); });

describe("the web client at 400 px", () => {
  it("lays itself out compactly and says which client it is", async () => {
    renderCompactClient();
    await waitFor(() => expect(document.body.dataset.profile).toBe("compact"));
    expect(document.body.dataset.client).toBe("compact");
  });

  it("opens on the threads it is supervising, worst first", async () => {
    const client = renderCompactClient();
    const list = await screen.findByRole("list", { name: "Threads" });
    client.emit(running("t-c"));
    client.emit({ type: "extension-ui-prompt", sessionId: "t-b", prompt: { id: "q1", sessionId: "t-b", kind: "confirm", title: "Delete the branch?" } });
    await waitFor(() => expect(within(list).getAllByRole("listitem")[0].textContent).toContain("Ship the web client"));
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((row) => row.dataset.status)).toEqual(["waiting", "running", "done"]);
    expect(rows[0].textContent).toContain("Waiting for an answer");
    expect(rows[1].textContent).toContain("Fix the flaky test");
  });

  it("opens a thread with one tap", async () => {
    const client = renderCompactClient();
    await screen.findByRole("list", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Open thread Rename the store" }));
    await waitFor(() => expect(client.calls.some((call) => call.method === "switchSession")).toBe(true));
    expect(client.calls.find((call) => call.method === "switchSession")?.args[0]).toBe("/sessions/t-a.json");
  });

  it("stops a running thread without opening it", async () => {
    const client = renderCompactClient();
    await screen.findByRole("list", { name: "Threads" });
    client.emit(running("t-b"));
    const stop = await screen.findByRole("button", { name: "Stop Ship the web client" });
    fireEvent.click(stop);
    await waitFor(() => expect(client.calls.some((call) => call.method === "abort")).toBe(true));
    expect(client.calls.find((call) => call.method === "abort")?.args[0]).toBe("t-b");
  });

  it("answers a Pi confirm on the thread that is open", async () => {
    const client = renderCompactClient();
    await screen.findByRole("list", { name: "Threads" });
    client.emit({ type: "extension-ui-prompt", sessionId: "t-a", prompt: { id: "q7", sessionId: "t-a", kind: "confirm", title: "Run the migration?" } });
    await screen.findByText("Run the migration?");
    fireEvent.click(screen.getByRole("button", { name: /Yes/u }));
    await waitFor(() => expect(client.calls.some((call) => call.method === "answerExtensionUi")).toBe(true));
    const answer = client.calls.find((call) => call.method === "answerExtensionUi");
    expect(answer?.args).toEqual(["q7", { confirmed: true }]);
  });

  it("sends a prompt from the composer at the bottom", async () => {
    const client = renderCompactClient();
    await screen.findByRole("list", { name: "Threads" });
    const textarea = await screen.findByRole("textbox");
    fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(client.calls.some((call) => call.method === "sendPrompt")).toBe(true));
    expect(client.calls.find((call) => call.method === "sendPrompt")?.args[0]).toBe("ship it");
  });

  it("draws no workspace dock and no thread column: this client cannot", async () => {
    renderCompactClient();
    await screen.findByRole("list", { name: "Threads" });
    expect(document.querySelector(".instrument-dock")).toBeNull();
    expect(document.querySelector(".session-rail")).toBeNull();
    // The list is reachable from the chrome once a thread is open, too.
    expect(screen.getByRole("button", { name: "Threads" })).toBeTruthy();
  });

  it("opens the thread list as a sheet from the title bar", async () => {
    renderCompactClient();
    await screen.findByRole("list", { name: "Threads" });
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const sheet = await screen.findByRole("dialog", { name: "Threads" });
    expect(within(sheet).getByRole("button", { name: "Open thread Rename the store" })).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    const reopened = await screen.findByRole("dialog", { name: "Threads" });
    fireEvent.click(within(reopened).getByRole("button", { name: "Close threads" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Threads" })).toBeNull());
  });
});
