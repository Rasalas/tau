// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer } from "./Composer";
import type { ComposerAttachmentHandle } from "./Composer";

function renderComposer(
  onSubmit = vi.fn(),
  attachmentRef?: React.RefObject<ComposerAttachmentHandle | null>,
  snapshot: HostSnapshot = {
    cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
    thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
    activeTools: [], allTools: [], extensionCount: 0, serviceTier: "standard",
    serviceTierAvailable: false, supportsImageInput: true,
  },
  draftStorageKey = "thread:session",
) {
  const element = (scope: string) => (
    <Composer
      draftStorageKey={scope}
      queue={[]}
      accessLevel="full"
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      attachmentRef={attachmentRef}
      snapshot={snapshot}
      onSubmit={onSubmit}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onSetServiceTier={() => {}}
      onSetAccess={() => {}}
      onCompactContext={() => {}}
      workspaceBusy={false}
      onOpenWorktree={async () => true}
      onCreateWorktree={async () => true}
      onSwitchRef={async () => true}
    />
  );
  const view = render(element(draftStorageKey));
  return Object.assign(onSubmit, { view, rerenderScope: (scope: string) => view.rerender(element(scope)) });
}

function sizedImageFile(name: string, size: number): File {
  const file = new File([new Uint8Array([1])], name, { type: "image/png" });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

afterEach(cleanup);

describe("Composer attachments", () => {
  it("shows a selected image above the text line, opens it large, and submits its bytes", async () => {
    const onSubmit = renderComposer();
    expect(screen.getByRole("button", { name: "Attach files" })).toBeTruthy();
    const input = screen.getByLabelText("Choose attachment files") as HTMLInputElement;
    const image = new File([new Uint8Array([137, 80, 78, 71])], "diagram.png", { type: "image/png" });

    fireEvent.change(input, { target: { files: [image] } });

    const thumbnail = await screen.findByRole("button", { name: "Preview diagram.png" });
    expect(thumbnail.closest(".composer-attachments")).toBeTruthy();
    fireEvent.click(thumbnail);
    expect(screen.getByRole("dialog", { name: "diagram.png" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(onSubmit.mock.calls[0]?.[0]).toBe("");
    expect(onSubmit.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ name: "diagram.png", mimeType: "image/png", kind: "image" }),
    ]);
    expect(onSubmit.mock.calls[0]?.[1]?.[0]?.data).toMatch(/^iVBORw==$/u);
  });

  it("accepts images through the composer drop handle", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    renderComposer(vi.fn(), attachmentRef);
    const image = new File([new Uint8Array([137, 80, 78, 71])], "dropped.png", { type: "image/png" });

    attachmentRef.current?.addFiles([image]);

    expect(await screen.findByRole("button", { name: "Preview dropped.png" })).toBeTruthy();
  });

  it("keeps valid files after unsupported files in the same drop", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    renderComposer(vi.fn(), attachmentRef);
    const image = new File([new Uint8Array([137, 80, 78, 71])], "valid.png", { type: "image/png" });

    await attachmentRef.current?.addFiles([
      new File(["text"], "notes.txt", { type: "text/plain" }),
      image,
    ]);

    expect(await screen.findByRole("button", { name: "Preview valid.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview notes.txt" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/not a supported/u);
  });

  it("does not attach files when the active runtime lacks image input", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    renderComposer(vi.fn(), attachmentRef, {
      cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
      thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
      activeTools: [], allTools: [], extensionCount: 0, serviceTier: "standard",
      serviceTierAvailable: false, supportsImageInput: false,
    });

    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "blocked.png", { type: "image/png" })]);

    expect((await screen.findByRole("alert")).textContent).toMatch(/unavailable/u);
    expect(screen.queryByRole("button", { name: "Preview blocked.png" })).toBeNull();
  });

  it("keeps existing attachments when a dropped file is unsupported", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    renderComposer(vi.fn(), attachmentRef);
    const image = new File([new Uint8Array([137, 80, 78, 71])], "kept.png", { type: "image/png" });
    attachmentRef.current?.addFiles([image]);
    expect(await screen.findByRole("button", { name: "Preview kept.png" })).toBeTruthy();

    attachmentRef.current?.addFiles([new File(["text"], "notes.txt", { type: "text/plain" })]);

    expect((await screen.findByRole("alert")).textContent).toMatch(/not a supported/u);
    expect(screen.getByRole("button", { name: "Preview kept.png" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Preview notes.txt" })).toBeNull();
  });

  it("enforces the shared total image-size limit before reading a drop", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    renderComposer(vi.fn(), attachmentRef);
    attachmentRef.current?.addFiles([
      sizedImageFile("one.png", 8 * 1024 * 1024),
      sizedImageFile("two.png", 8 * 1024 * 1024),
      sizedImageFile("three.png", 8 * 1024 * 1024),
      sizedImageFile("four.png", 1),
    ]);

    expect(await screen.findAllByRole("button", { name: /Preview (one|two|three)\.png/u })).toHaveLength(3);
    expect((await screen.findByRole("alert")).textContent).toMatch(/24 MB/u);
    expect(screen.queryByRole("button", { name: "Preview four.png" })).toBeNull();
  });

  it("serializes concurrent drops so the total limit cannot be bypassed", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    renderComposer(vi.fn(), attachmentRef);
    const first = attachmentRef.current!.addFiles([
      sizedImageFile("one.png", 8 * 1024 * 1024),
      sizedImageFile("two.png", 8 * 1024 * 1024),
    ]);
    const second = attachmentRef.current!.addFiles([
      sizedImageFile("three.png", 8 * 1024 * 1024),
      sizedImageFile("four.png", 8 * 1024 * 1024),
    ]);

    await Promise.all([first, second]);

    await waitFor(() => expect(screen.getAllByRole("button", { name: /Preview (one|two|three)\.png/u })).toHaveLength(3));
    expect(screen.queryByRole("button", { name: "Preview four.png" })).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/24 MB/u);
  });

  it("keeps attachments when submission is rejected", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    const onSubmit = vi.fn(async () => false);
    renderComposer(onSubmit, attachmentRef);
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "retain.png", { type: "image/png" })]);
    expect(await screen.findByRole("button", { name: "Preview retain.png" })).toBeTruthy();
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "retain this prompt" } });

    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    expect(screen.getByRole("button", { name: "Preview retain.png" })).toBeTruthy();
    expect(draft.value).toBe("retain this prompt");
  });

  it("keeps queued drops with their originating thread scope", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    const submission = renderComposer(vi.fn(), attachmentRef, undefined, "thread:a");
    const pending = attachmentRef.current!.addFiles([new File([new Uint8Array([1])], "thread-a.png", { type: "image/png" })]);
    submission.rerenderScope("thread:b");
    await pending;
    expect(screen.queryByRole("button", { name: "Preview thread-a.png" })).toBeNull();
    submission.rerenderScope("thread:a");
    expect(await screen.findByRole("button", { name: "Preview thread-a.png" })).toBeTruthy();
  });

  it("preserves edits and new attachments when a pending submission succeeds", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (accepted: boolean) => void;
    const onSubmit = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    renderComposer(onSubmit, attachmentRef);
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "sent.png", { type: "image/png" })]);
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "first prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    fireEvent.change(draft, { target: { value: "new prompt" } });
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "new.png", { type: "image/png" })]);
    resolve(true);
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview new.png" })).toBeTruthy());
    expect(draft.value).toBe("new prompt");
    expect(screen.queryByRole("button", { name: "Preview sent.png" })).toBeNull();
  });

  it("does not bypass attachment limits while restoring a rejected submission", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (accepted: boolean) => void;
    const onSubmit = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    renderComposer(onSubmit, attachmentRef);
    await attachmentRef.current?.addFiles([
      new File([new Uint8Array([1])], "one.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "two.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "three.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "four.png", { type: "image/png" }),
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await attachmentRef.current?.addFiles([
      new File([new Uint8Array([1])], "five.png", { type: "image/png" }),
      new File([new Uint8Array([1])], "six.png", { type: "image/png" }),
    ]);
    resolve(false);
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Preview/u })).toHaveLength(4));
    expect(screen.queryByRole("button", { name: "Preview five.png" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview six.png" })).toBeNull();
  });
});
