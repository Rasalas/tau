// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer } from "./Composer";

function renderComposer(onSubmit = vi.fn()) {
  render(
    <Composer
      queue={[]}
      accessLevel="full"
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
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
});
