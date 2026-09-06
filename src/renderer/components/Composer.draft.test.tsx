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

function renderComposer(onSubmit: () => Promise<SubmissionResult>, storage: ClientStorage) {
  render(
    <ClientStorageProvider storage={storage}>
      <RendererServicesProvider services={createRendererServices()}>
        <Composer
          scopeStore={new ComposerScopeStore()}
          snapshot={snapshot}
          draftStorageKey={DRAFT_KEY}
          queue={[]}
          contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
          textareaRef={createRef<HTMLTextAreaElement>()}
          onSubmit={onSubmit}
          onAbort={() => {}}
          onCancelQueued={() => {}}
          onSteerQueued={() => {}}
          onReorderQueue={() => {}}
          onSetModel={() => {}}
          onSetThinking={() => {}}
          onCompactContext={() => {}}
        />
      </RendererServicesProvider>
    </ClientStorageProvider>,
  );
  return screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
}

afterEach(cleanup);

describe("Composer draft persistence", () => {
  it("drops the persisted draft of a prompt the host accepted", async () => {
    const storage = createMemoryStorage();
    const textarea = renderComposer(async () => ({ accepted: true }), storage);

    fireEvent.change(textarea, { target: { value: "ship it", selectionStart: 7 } });
    expect(readComposerDraft(storage, DRAFT_KEY)).toBe("ship it");

    fireEvent.keyDown(textarea, { key: "Enter" });
    // A restart reads this key; a sent prompt must not come back with it.
    await waitFor(() => expect(readComposerDraft(storage, DRAFT_KEY)).toBe(""));
  });

  it("persists what was typed while the accepted prompt was in flight", async () => {
    const storage = createMemoryStorage();
    let accept: (result: SubmissionResult) => void = () => {};
    const onSubmit = vi.fn(() => new Promise<SubmissionResult>((resolve) => { accept = resolve; }));
    const textarea = renderComposer(onSubmit, storage);

    fireEvent.change(textarea, { target: { value: "first", selectionStart: 5 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
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
  });
});
