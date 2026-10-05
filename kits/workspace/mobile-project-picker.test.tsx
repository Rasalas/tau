// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { createFakeHostClient } from "../../src/renderer/test-support/fake-host-client.js";
import { renderApp } from "../../src/renderer/test-support/render-app.js";
import { workspaceHostStub } from "../../src/renderer/test-support/workspace-host-stub.js";
import { setClientStorage, setHostClient } from "../../src/renderer/test-support/kit-harness.js";
import { workspaceExtension } from "./desktop.js";

afterEach(() => {
  cleanup(); setHostClient(undefined); setClientStorage(undefined);
  window.history.replaceState({}, "", "/");
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
});

it.each(["compact", "web"])("opens host folders from New thread → Add project on a phone and adds a typed path on %s", async (profile) => {
  window.history.replaceState({}, "", `/?profile=${profile}`);
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  const listDirectories = vi.fn(async (path?: string) => path === "/repos/tau/" || path === "/repos/tau"
    ? { path: "/repos/tau", parent: "/repos", directories: [], workspace: { workspaceId: "ws-tau", displayPath: "/repos/tau" } }
    : { path: "/repos", parent: "/", directories: [{ name: "tau", path: "/repos/tau" }], workspace: { workspaceId: "ws-repos", displayPath: "/repos" } });
  const openProject = vi.fn(async () => ({ version: 1 as const, updates: [] }));
  const client = createFakeHostClient({
    hasCapability: () => false,
    bootstrap: async () => ({
      version: 1,
      threadIndex: {
        projects: [{ path: "/repos", name: "repos", lastOpenedAt: 1 }, { path: "/other", name: "other", lastOpenedAt: 2 }],
        sessions: [],
      },
      detail: { sessionId: "", messages: [], isStreaming: false, activeTools: [] },
      catalog: { models: [], thinkingLevel: "", thinkingLevels: [], allTools: [], extensionCount: 0 },
      project: { cwd: "/repos" },
    }),
    openProject,
    invokeHostExtension: workspaceHostStub({ listDirectories }),
  });
  renderApp(client, { extensions: [workspaceExtension] });
  fireEvent.click(await screen.findByRole("button", { name: "New thread" }));
  fireEvent.click(await screen.findByRole("button", { name: /^Change project/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Add project" }));
  fireEvent.click(await screen.findByRole("button", { name: /Local folder/u }));
  await screen.findByRole("option", { name: "tau" });
  expect(screen.queryByRole("button", { name: /Choose a folder/u })).toBeNull();
  const input = screen.getByRole("textbox", { name: "Folder path" });
  fireEvent.change(input, { target: { value: "/repos/tau/" } });
  await screen.findByText("No folders in here");
  fireEvent.click(screen.getByRole("button", { name: /^Add/u }));
  await waitFor(() => expect(openProject).toHaveBeenCalledWith("ws-tau"));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add project" })).toBeNull());
});
