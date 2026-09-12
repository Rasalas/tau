// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useComposerAttachments } from "./useComposerAttachments";
import { ComposerScopeStore, createDraftKey } from "../../workbench/composer-scope-store";
import type { PendingAttachment } from "../../workbench/composer-scope-store";

describe("useComposerAttachments", () => {
  it("manages previewId and finds preview attachment", () => {
    const scopeStore = new ComposerScopeStore();
    const scope = createDraftKey("thread:1");
    const attachment: PendingAttachment = {
      id: 101,
      kind: "image",
      name: "test.png",
      mimeType: "image/png",
      data: "abc",
      size: 100,
      previewUrl: "data:image/png;base64,abc",
    };

    const { result } = renderHook(() =>
      useComposerAttachments({
        scopeStore,
        scope,
        attachments: [attachment],
        supportsImageInput: true,
      })
    );

    expect(result.current.previewId).toBeUndefined();
    expect(result.current.preview).toBeUndefined();

    act(() => {
      result.current.setPreviewId(101);
    });

    expect(result.current.previewId).toBe(101);
    expect(result.current.preview?.name).toBe("test.png");

    act(() => {
      result.current.clearPreviewForScope(scope);
    });

    expect(result.current.previewId).toBeUndefined();
  });

  it("removes attachments via removeAttachment", () => {
    const scopeStore = new ComposerScopeStore();
    const scope = createDraftKey("thread:2");
    const attachment: PendingAttachment = {
      id: 102,
      kind: "image",
      name: "remove.png",
      mimeType: "image/png",
      data: "abc",
      size: 100,
      previewUrl: "data:image/png;base64,abc",
    };
    scopeStore.setAttachments(scope, [attachment]);

    const { result } = renderHook(() =>
      useComposerAttachments({
        scopeStore,
        scope,
        attachments: [attachment],
        supportsImageInput: true,
      })
    );

    act(() => {
      result.current.removeAttachment(102);
    });

    expect(scopeStore.getSnapshot(scope).attachments).toEqual([]);
  });
});
