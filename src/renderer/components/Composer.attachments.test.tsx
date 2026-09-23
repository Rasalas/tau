// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, type SubmitResult } from "./Composer";
import type { ComposerAttachmentHandle } from "./Composer";
import { ComposerScopeStore, createDraftKey } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";

function renderComposer(
  onSubmit = vi.fn(),
  attachmentRef?: React.RefObject<ComposerAttachmentHandle | null>,
  snapshot: HostSnapshot = {
    cwd: "/project", sessionId: "session", sessionTitle: "Thread", models: [],
    thinkingLevel: "off", thinkingLevels: ["off"], messages: [], isStreaming: false,
    activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: true,
  },
  draftStorageKey = "thread:session",
) {
  const scopeStore = new ComposerScopeStore();
  const element = (scope: string) => (
    <TestProviders>
      <Composer
        scopeStore={scopeStore}
        draftStorageKey={scope}
        queue={[]}
        contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
        textareaRef={createRef<HTMLTextAreaElement>()}
        attachmentRef={attachmentRef}
        snapshot={snapshot}
        onSubmit={onSubmit}
        onAbort={() => {}}
        onCancelQueued={() => {}}
        onSteerQueued={() => {}}
        onSetModel={() => {}}
        onSetThinking={() => {}}
        onCompactContext={() => {}}
      />
    </TestProviders>
  );
  const view = render(element(draftStorageKey));
  return Object.assign(onSubmit, {
    view,
    scopeStore,
    rerenderScope: (scope: string) => view.rerender(element(scope)),
  });
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
    const dialog = screen.getByRole("dialog", { name: "diagram.png" });
    expect(dialog.parentElement).toBe(document.body);
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

  it("waits for an in-flight drop before capturing the submission", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    const onSubmit = vi.fn(async (_text: string, submitted: Array<{ name: string }>): Promise<SubmitResult> => {
      expect(submitted.map((attachment) => attachment.name)).toEqual(["immediate.png"]);
      return { accepted: true };
    });
    renderComposer(onSubmit, attachmentRef);
    const drop = attachmentRef.current!.addFiles([
      new File([new Uint8Array([137, 80, 78, 71])], "immediate.png", { type: "image/png" }),
    ]);

    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "send with image" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await drop;
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
      activeTools: [], allTools: [], extensionCount: 0, supportsImageInput: false,
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
    const onSubmit = vi.fn(async (): Promise<SubmitResult> => ({ accepted: false, message: "Prompt rejected." }));
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

  it("does not start a second submission for a double click", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (result: SubmitResult) => void;
    const onSubmit = vi.fn(() => new Promise<SubmitResult>((done) => { resolve = done; }));
    renderComposer(onSubmit, attachmentRef);
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "once" } });
    const send = screen.getByRole("button", { name: "Send" });
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    const pendingSend = screen.getByRole("button", { name: "Send" });
    expect((pendingSend as HTMLButtonElement).disabled).toBe(true);
    expect(pendingSend.getAttribute("aria-busy")).toBe("true");
    resolve({ accepted: true });
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

  it("moves a delayed file reader with its scope during thread promotion", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let finishRead!: () => void;
    class DelayedFileReader {
      result: string | ArrayBuffer | null = null;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      readAsDataURL(file: File) {
        finishRead = () => {
          this.result = `data:${file.type};base64,cmVhZA==`;
          this.onload?.();
        };
      }
    }
    vi.stubGlobal("FileReader", DelayedFileReader);
    const submission = renderComposer(vi.fn(), attachmentRef, undefined, "thread:prepared");
    const pending = attachmentRef.current!.addFiles([
      new File([new Uint8Array([1])], "promoted.png", { type: "image/png" }),
    ]);

    await waitFor(() => expect(finishRead).toBeTypeOf("function"));
    submission.scopeStore.moveScope(createDraftKey("thread:prepared"), createDraftKey("thread:active"));
    submission.rerenderScope("thread:active");
    finishRead();
    await pending;

    expect(await screen.findByRole("button", { name: "Preview promoted.png" })).toBeTruthy();
    submission.rerenderScope("thread:prepared");
    expect(screen.queryByRole("button", { name: "Preview promoted.png" })).toBeNull();
    vi.unstubAllGlobals();
  });

  it("preserves edits and new attachments when a pending submission succeeds", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (result: SubmitResult) => void;
    const onSubmit = vi.fn(() => new Promise<SubmitResult>((done) => { resolve = done; }));
    renderComposer(onSubmit, attachmentRef);
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "sent.png", { type: "image/png" })]);
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "first prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    fireEvent.change(draft, { target: { value: "new prompt" } });
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "new.png", { type: "image/png" })]);
    resolve({ accepted: true });
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview new.png" })).toBeTruthy());
    expect(draft.value).toBe("new prompt");
    expect(screen.queryByRole("button", { name: "Preview sent.png" })).toBeNull();
  });

  it("preserves text edited away and back while submission is pending", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (result: SubmitResult) => void;
    const onSubmit = vi.fn(() => new Promise<SubmitResult>((done) => { resolve = done; }));
    renderComposer(onSubmit, attachmentRef);
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "sent.png", { type: "image/png" })]);
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "first prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    fireEvent.change(draft, { target: { value: "temporary edit" } });
    fireEvent.change(draft, { target: { value: "first prompt" } });
    resolve({ accepted: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Preview sent.png" })).toBeNull());
    expect(draft.value).toBe("first prompt");
  });

  it("keeps a newer attachment error after an older submission succeeds", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (result: SubmitResult) => void;
    const onSubmit = vi.fn(() => new Promise<SubmitResult>((done) => { resolve = done; }));
    renderComposer(onSubmit, attachmentRef);
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "sent.png", { type: "image/png" })]);
    const draft = screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "first prompt" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledOnce());
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" })]);
    await waitFor(() => expect(screen.getByRole("alert").textContent).toMatch(/not a supported/u));
    resolve({ accepted: true });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Preview sent.png" })).toBeNull());
    expect(screen.getByRole("alert").textContent).toMatch(/not a supported/u);
  });

  it("does not bypass attachment limits while restoring a rejected submission", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    let resolve!: (result: SubmitResult) => void;
    const onSubmit = vi.fn(() => new Promise<SubmitResult>((done) => { resolve = done; }));
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
    resolve({ accepted: false, message: "Prompt rejected." });
    await waitFor(() => expect(screen.getAllByRole("button", { name: /Preview/u })).toHaveLength(4));
    expect(screen.queryByRole("button", { name: "Preview five.png" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Preview six.png" })).toBeNull();
  });

  it("keeps out-of-order submission results isolated by composer scope", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    const resolvers = new Map<string, (result: SubmitResult) => void>();
    const onSubmit = vi.fn((text: string) => new Promise<SubmitResult>((resolve) => { resolvers.set(text, resolve); }));
    const submission = renderComposer(onSubmit, attachmentRef, undefined, "thread:a");

    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "a.png", { type: "image/png" })]);
    await screen.findByRole("button", { name: "Preview a.png" });
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    submission.rerenderScope("thread:b");
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "b.png", { type: "image/png" })]);
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    resolvers.get("a")?.({ accepted: false, message: "Prompt rejected." });
    resolvers.get("b")?.({ accepted: true });
    await waitFor(() => expect((screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement).value).toBe(""));
    expect(screen.queryByRole("button", { name: "Preview b.png" })).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();

    submission.rerenderScope("thread:a");
    expect(await screen.findByRole("button", { name: "Preview a.png" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/u);
  });

  it("does not let an older success clear a newer scope failure", async () => {
    const attachmentRef = createRef<ComposerAttachmentHandle>();
    const resolvers = new Map<string, (result: SubmitResult) => void>();
    const settled = new Map<string, Promise<void>>();
    const onSubmit = vi.fn((text: string) => new Promise<SubmitResult>((resolve) => {
      let markSettled!: () => void;
      settled.set(text, new Promise<void>((done) => { markSettled = done; }));
      resolvers.set(text, (result) => { resolve(result); markSettled(); });
    }));
    const submission = renderComposer(onSubmit, attachmentRef, undefined, "thread:a");

    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "a.png", { type: "image/png" })]);
    await screen.findByRole("button", { name: "Preview a.png" });
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    submission.rerenderScope("thread:b");
    await attachmentRef.current?.addFiles([new File([new Uint8Array([1])], "b.png", { type: "image/png" })]);
    fireEvent.change(screen.getByPlaceholderText(/Direct the agent/u), { target: { value: "b" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    resolvers.get("b")?.({ accepted: false, message: "Prompt rejected." });
    resolvers.get("a")?.({ accepted: true });
    await Promise.all([settled.get("a"), settled.get("b")]);
    submission.rerenderScope("thread:a");
    await waitFor(() => expect(screen.queryByRole("button", { name: "Preview a.png" })).toBeNull());
    submission.rerenderScope("thread:b");
    await waitFor(() => expect(screen.getByRole("button", { name: "Preview b.png" })).toBeTruthy());
    expect(screen.getByRole("alert").textContent).toMatch(/rejected/u);
    expect((screen.getByPlaceholderText(/Direct the agent/u) as HTMLTextAreaElement).value).toBe("b");
  });
});
