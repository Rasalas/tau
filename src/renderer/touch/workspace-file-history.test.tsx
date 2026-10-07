// @vitest-environment jsdom
import { StrictMode, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PHONE_HOME, type PhoneRoute } from "../../workbench/phone-route";
import { phoneReaderFromState, routeFromState } from "../../workbench/phone-history";
import { ThreadStore } from "../../workbench/thread-store";
import { ThreadStoreContext } from "../workbench-context";
import type { DocumentSourceContribution } from "../extension-system";
import { ClientEnvironmentProvider, electronClientEnvironment } from "../client-environment";
import { TestProviders } from "../test-support/test-providers";
import { TouchLayer } from "./TouchLayer";
import { WorkspaceFileSheet } from "./WorkspaceFileSheet";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
const chat: PhoneRoute = { kind: "chat", thread: "A" };
function fixture({ restore = false, strict = false }: { restore?: boolean; strict?: boolean } = {}) {
  const store = new ThreadStore();
  store.applyThreadIndex({ projects: [], sessions: [{ id: "A", path: "/session-A", title: "A", projectPath: "/repo-A", workspaceId: "opaque-A", projectName: "A", modifiedAt: 1, messageCount: 1 }] });
  store.setActiveThread("A");
  const openThread = vi.fn(async () => true);
  const loads = vi.fn(async (path: string) => ({ path, name: path, kind: "text" as const, size: 1, text: `content of ${path}` }));
  const state = { changes: { files: [], added: 0, removed: 0 } };
  const source: DocumentSourceContribution = { id: "documents", loadFile: loads, loadDiff: async (path) => ({ path, added: 0, removed: 0, hunks: [] }), getState: () => state, subscribe: () => () => undefined, openInEditor: () => undefined };
  function Harness() {
    const [route, setRoute] = useState<PhoneRoute>(restore ? chat : PHONE_HOME);
    const [reader, setReader] = useState<string | undefined>(restore ? "first.md" : undefined);
    return <><TouchLayer syncUrl phone={{ route, onRoute: setRoute }} openThread={openThread} />
      <output>{route.kind === "chat" ? "chat A" : "thread list"}</output>
      <button onClick={() => setRoute(chat)}>Open chat</button>
      <button onClick={() => setReader("first.md")}>Open reader</button>
      <button onClick={() => setReader("second.md")}>Replace reader</button>
      {reader ? <WorkspaceFileSheet key={reader} tab={{ id: reader, path: reader, kind: "file", preview: true, view: "source", resourceOrigin: { sessionId: "A", workspace: "opaque-A", sourceId: "documents" } }} source={source} onClose={() => setReader(undefined)} /> : null}
    </>;
  }
  const tree = <ClientEnvironmentProvider environment={electronClientEnvironment(new URLSearchParams("profile=compact"))}><TestProviders><ThreadStoreContext.Provider value={store}><Harness /></ThreadStoreContext.Provider></TestProviders></ClientEnvironmentProvider>;
  return { ...render(strict ? <StrictMode>{tree}</StrictMode> : tree), loads, openThread };
}

async function backToList(openThread: ReturnType<typeof vi.fn>) {
  window.history.back();
  await waitFor(() => expect(routeFromState(window.history.state)).toEqual(PHONE_HOME));
  await screen.findByText("thread list");
  expect(openThread).not.toHaveBeenCalled();
}

describe("route-owned reader history controls", () => {
  it("StrictMode and a replacement reader retain exactly one modal step", async () => {
    window.history.replaceState(null, "", "/");
    const { loads, openThread } = fixture({ strict: true });
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual(chat));
    fireEvent.click(screen.getByRole("button", { name: "Open reader" }));
    await screen.findByText("content of first.md");
    const length = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: "Replace reader" }));
    await screen.findByText("content of second.md");
    expect(loads).toHaveBeenCalledWith("second.md", { workspace: "opaque-A" });
    expect(window.history.length).toBe(length);
    expect(phoneReaderFromState(window.history.state)?.route).toEqual(chat);
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)).toEqual(chat);
    await backToList(openThread);
  });

  it("restoring the reader on a retained history entry does not add a reload step", async () => {
    window.history.replaceState(null, "", "/");
    const first = fixture();
    fireEvent.click(screen.getByRole("button", { name: "Open chat" }));
    await waitFor(() => expect(routeFromState(window.history.state)).toEqual(chat));
    fireEvent.click(screen.getByRole("button", { name: "Open reader" }));
    await screen.findByText("content of first.md");
    const length = window.history.length;
    first.unmount();
    const second = fixture({ restore: true });
    await screen.findByText("content of first.md");
    expect(window.history.length).toBe(length);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(routeFromState(window.history.state)).toEqual(chat);
    await backToList(second.openThread);
  });
});
