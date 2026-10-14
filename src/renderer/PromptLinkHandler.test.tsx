// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "./extension-system";
import type { ThreadStore } from "../workbench/thread-store";
import type { Platform } from "../workbench/platform";
import type { ClientStorage } from "../workbench/client-storage";
import { STORAGE_KEYS } from "../workbench/storage-keys";
import { createMemoryStorage } from "../workbench/client-storage";
import { Markdown } from "./components/Markdown";
import { PromptLinkReceiver } from "./PromptLinkReceiver";
import { openPromptLink } from "./prompt-link-event";
import { HostClientProvider } from "./host-client-context";
import { PlatformProvider } from "./platform-context";
import { createFakeHostClient } from "./test-support/fake-host-client";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });

function setup(text = "", native: string[] = [], options: { environments?: Platform["environments"]; storage?: ClientStorage } = {}) {
  let draft = text;
  const setComposerDraft = vi.fn((value: string) => { draft = value; });
  const submitPrompt = vi.fn();
  const actions = {
    activeThread: () => ({ draftPending: true, workspaceId: "ws", cwd: "/project" }),
    composerDraft: () => draft, setComposerDraft, focusComposer: vi.fn(), newSession: vi.fn(), notify: vi.fn(), submitPrompt,
  } as unknown as WorkbenchActions;
  const threads = { getProjects: () => [{ path: "/project", workspaceId: "ws", name: "Project", lastOpenedAt: 0 }] } as unknown as ThreadStore;
  const client = createFakeHostClient({ windowAction: async (action) => action.kind === "take-links" ? native.splice(0) : undefined });
  const platform = { ...options, storage: options.storage ?? createMemoryStorage(), clipboard: { writeText: async () => {} }, openExternal: vi.fn(), importModule: async () => ({}) };
  render(<StrictMode><HostClientProvider client={client}><PlatformProvider platform={platform}>
    <PromptLinkReceiver actions={actions} threads={threads} scope="draft:1" />
  </PlatformProvider></HostClientProvider></StrictMode>);
  return { actions, client, setComposerDraft, submitPrompt };
}

describe("prompt link delivery", () => {
  it("consumes a phone launch route once under StrictMode and removes the prompt from the address", async () => {
    window.history.replaceState(null, "", "/?host=h&prompt=%2Fdeploy&send=true");
    const { setComposerDraft, submitPrompt } = setup();
    await waitFor(() => expect(setComposerDraft).toHaveBeenCalledWith("/deploy"));
    expect(setComposerDraft).toHaveBeenCalledTimes(1);
    expect(window.location.search).not.toContain("prompt");
    expect(submitPrompt).not.toHaveBeenCalled();
  });
  it("takes a native cold-start link once and handles later OS deliveries", async () => {
    const pending = ["tau://new?prompt=First"];
    const { client, setComposerDraft, submitPrompt } = setup("", pending);
    await waitFor(() => expect(setComposerDraft).toHaveBeenCalledWith("First"));
    pending.push("tau://new?prompt=Second");
    act(() => client.emit({ type: "window-shell", event: { kind: "links-available" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Replace text" }));
    await waitFor(() => expect(setComposerDraft).toHaveBeenCalledWith("Second"));
    expect(submitPrompt).not.toHaveBeenCalled();
  });
  it("keeps existing text when the replacement dialog is cancelled", async () => {
    const { actions, setComposerDraft } = setup("Keep this");
    act(() => openPromptLink("tau://new?prompt=Replace"));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(actions.composerDraft()).toBe("Keep this");
    expect(setComposerDraft).not.toHaveBeenCalled();
  });
});

it("carries the prompt through a desktop machine switch before placing it", async () => {
  let shown = "here";
  const open = vi.fn(async (id: string) => { shown = id; });
  const environments = { getSnapshot: () => ({ shown, environments: [{ id: "other", status: "connected" }] }), open } as unknown as NonNullable<Platform["environments"]>;
  const storage = createMemoryStorage();
  const first = setup("", ["tau://new?host=other&prompt=Remote&project=ws"], { environments, storage });
  await waitFor(() => expect(open).toHaveBeenCalledWith("other"));
  expect(first.setComposerDraft).not.toHaveBeenCalled();
  expect(storage.get(STORAGE_KEYS.promptLinkArrival)).toContain("prompt=Remote");
  cleanup();
  const second = setup("", [], { environments, storage });
  await waitFor(() => expect(second.setComposerDraft).toHaveBeenCalledWith("Remote"));
  expect(storage.get(STORAGE_KEYS.promptLinkArrival)).toBeNull();
  expect(second.submitPrompt).not.toHaveBeenCalled();
});


it("keeps native links queued while the workflow chunk loads", async () => {
  const { setComposerDraft, submitPrompt } = setup("", ["tau://new?prompt=First", "tau://new?prompt=Second"]);
  await waitFor(() => expect(setComposerDraft).toHaveBeenCalledWith("First"));
  fireEvent.click(await screen.findByRole("button", { name: "Replace text" }));
  await waitFor(() => expect(setComposerDraft).toHaveBeenCalledWith("Second"));
  expect(setComposerDraft).toHaveBeenCalledTimes(2);
  expect(submitPrompt).not.toHaveBeenCalled();
});

it("opens prepared text from a chat link through the small event bridge", async () => {
  const { setComposerDraft, submitPrompt } = setup();
  render(<Markdown>{"[Prepare](tau://new?prompt=Chat)"}</Markdown>);
  fireEvent.click(await screen.findByRole("button", { name: "Prepare" }));
  await waitFor(() => expect(setComposerDraft).toHaveBeenCalledWith("Chat"));
  expect(submitPrompt).not.toHaveBeenCalled();
});
