// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot, SubmissionResult } from "../../shared/contracts";
import { Composer } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { createMemoryStorage, type ClientStorage } from "../../workbench/client-storage";
import { ClientStorageProvider } from "../client-storage-context";
import { createRendererServices } from "../renderer-services";
import { RendererServicesProvider } from "../renderer-services-context";
import { readComposerDraft } from "../../workbench/draft-store";
import { createDraftKey } from "../../workbench/composer-scope-store";
import { loadStoredPromptHistory, PROMPT_HISTORY_STORAGE_KEY, saveStoredPromptHistory } from "../../workbench/prompt-history";

const snapshot: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [],
  thinkingLevel: "medium",
  thinkingLevels: ["medium"],
  messages: [],
  isStreaming: false,
  activeTools: [],
  allTools: [],
  extensionCount: 0,
  supportsImageInput: true,
};

const DRAFT_KEY = createDraftKey("session:session");

function renderComposer(onSubmit: () => Promise<SubmissionResult>, storage: ClientStorage, initialSnapshot = snapshot, props: { onChange?(text: string): void; onNotify?(message: string, level?: "info" | "warning" | "error"): void } = {}) {
  render(
    <ClientStorageProvider storage={storage}>
      <RendererServicesProvider services={createRendererServices()}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={initialSnapshot}
          draftStorageKey={DRAFT_KEY}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={onSubmit}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
          {...props}
        />
      </RendererServicesProvider>
    </ClientStorageProvider>,
  );
  return screen.getByPlaceholderText(/Ask anything/u) as HTMLTextAreaElement;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("Composer draft persistence", () => {
  it("lets the current layout size an empty editor, including after clearing a draft", () => {
    // A draft mounts before the compact profile replaces the desktop's taller minimum.
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(78);
    const textarea = renderComposer(async () => ({ accepted: true }), createMemoryStorage());
    expect(textarea.style.height).toBe("");

    fireEvent.change(textarea, { target: { value: "First line\nSecond line" } });
    expect(textarea.style.height).toBe("78px");
    fireEvent.change(textarea, { target: { value: "" } });
    expect(textarea.style.height).toBe("");
    expect(textarea.style.overflowY).toBe("hidden");
  });

  it("records only the accepted prompt and saves history once", async () => {
    const storage = createMemoryStorage();
    saveStoredPromptHistory(storage, ["previously sent"]);
    const set = vi.spyOn(storage, "set");
    const historyWrites = () => set.mock.calls.filter(([key]) => key === PROMPT_HISTORY_STORAGE_KEY);
    const textarea = renderComposer(async () => ({ accepted: true }), storage, {
      ...snapshot,
      messages: [
        { id: "user-1", role: "user", text: "loaded first", timestamp: 1 },
        { id: "user-2", role: "user", text: "loaded second", timestamp: 2 },
      ],
    });
    expect(loadStoredPromptHistory(storage)).toEqual(["previously sent"]);
    expect(historyWrites()).toHaveLength(0);

    fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(loadStoredPromptHistory(storage)).toEqual(["previously sent", "ship it"]));
    await waitFor(() => expect(textarea.value).toBe(""));
    expect(historyWrites()).toHaveLength(1);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("ship it");
  });

  it("drops the persisted draft of a prompt the host accepted", async () => {
    const storage = createMemoryStorage();
    const textarea = renderComposer(async () => ({ accepted: true }), storage);

    fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
    expect(readComposerDraft(storage, DRAFT_KEY)).toBe("ship it");

    fireEvent.keyDown(textarea, { key: "Enter" });
    // A restart reads this key; a sent prompt must not come back with it.
    await waitFor(() => expect(readComposerDraft(storage, DRAFT_KEY)).toBe(""));
  });

  it("clears a submitted sentence immediately and keeps later typing separate", async () => {
    const storage = createMemoryStorage();
    let accept: (result: SubmissionResult) => void = () => {};
    const onSubmit = vi.fn(() => new Promise<SubmissionResult>((resolve) => { accept = resolve; }));
    const textarea = renderComposer(onSubmit, storage);

    fireEvent.change(textarea, { target: { value: "first sentence.", selectionStart: 15 } });
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("first sentence.", []));
    await waitFor(() => expect(textarea.value).toBe(""));

    fireEvent.change(textarea, { target: { value: "second", selectionStart: 6 } });
    accept({ accepted: true });
    await waitFor(() => expect(textarea.value).toBe("second"));
    expect(readComposerDraft(storage, DRAFT_KEY)).toBe("second");
  });

  it("keeps a rejected prompt in the persisted draft", async () => {
    const storage = createMemoryStorage();
    const textarea = renderComposer(async () => ({ accepted: false, message: "no" }), storage);

    fireEvent.change(textarea, { target: { value: "retry me", selectionStart: 8 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    await waitFor(() => expect(screen.getByText("no")).toBeTruthy());
    expect(readComposerDraft(storage, DRAFT_KEY)).toBe("retry me");
    expect(loadStoredPromptHistory(storage)).toEqual([]);
  });

  it("keeps typing and warns once when storage refuses the draft, until a write succeeds again", () => {
    const storage = createMemoryStorage();
    const set = storage.set;
    let full = true;
    storage.set = (key, value) => { if (full) throw new Error("QuotaExceededError"); set(key, value); };
    const onChange = vi.fn();
    const onNotify = vi.fn();
    const textarea = renderComposer(async () => ({ accepted: true }), storage, snapshot, { onChange, onNotify });

    fireEvent.change(textarea, { target: { value: "a", selectionStart: 1 } });
    fireEvent.change(textarea, { target: { value: "ab", selectionStart: 2 } });
    expect(textarea.value).toBe("ab");
    expect(onChange).toHaveBeenLastCalledWith("ab");
    expect(onNotify).toHaveBeenCalledTimes(1);
    expect(onNotify).toHaveBeenCalledWith(expect.stringContaining("Draft not saved"), "warning");

    full = false;
    fireEvent.change(textarea, { target: { value: "abc", selectionStart: 3 } });
    expect(readComposerDraft(storage, DRAFT_KEY)).toBe("abc");
    full = true;
    fireEvent.change(textarea, { target: { value: "abcd", selectionStart: 4 } });
    expect(onNotify).toHaveBeenCalledTimes(2);
  });
});
