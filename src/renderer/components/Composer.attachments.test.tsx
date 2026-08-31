// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";
import type { ComposerAttachmentHandle } from "./Composer";

function renderComposer(onSubmit = vi.fn(), attachmentRef?: React.RefObject<ComposerAttachmentHandle | null>) {
  render(
    <Composer
      queue={[]}
      accessLevel="full"
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      attachmentRef={attachmentRef}
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
    />,
  );
  return onSubmit;
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
    const image = (name: string, size: number) => {
      const file = new File([new Uint8Array([1])], name, { type: "image/png" });
      Object.defineProperty(file, "size", { value: size });
      return file;
    };

    attachmentRef.current?.addFiles([
      image("one.png", 8 * 1024 * 1024),
      image("two.png", 8 * 1024 * 1024),
      image("three.png", 8 * 1024 * 1024),
      image("four.png", 1),
    ]);

    expect(await screen.findAllByRole("button", { name: /Preview (one|two|three)\.png/u })).toHaveLength(3);
    expect((await screen.findByRole("alert")).textContent).toMatch(/24 MB/u);
    expect(screen.queryByRole("button", { name: "Preview four.png" })).toBeNull();
  });
});
