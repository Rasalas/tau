// @vitest-environment jsdom
import React, { StrictMode, useLayoutEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useNewThreadController } from "./use-new-thread-controller";
import { createMemoryStorage } from "../workbench/client-storage";
import { createNewThreadDraft } from "../workbench/draft-store";

afterEach(cleanup);

describe("useNewThreadController adapter", () => {
  it("renders a draft created after render but before the passive subscription", () => {
    const storage = createMemoryStorage();
    const draft = createNewThreadDraft({ projectPath: "/monitor", projectName: "monitor" });
    let current: ReturnType<typeof useNewThreadController>;
    function Harness() {
      const controller = useNewThreadController(storage);
      current = controller;
      useLayoutEffect(() => controller.begin(draft), [controller.begin]);
      return <output data-testid="draft">{controller.pendingNewThread?.draftId ?? "missing"}</output>;
    }
    render(<Harness />);
    expect(current!.current()?.draftId).toBe(draft.draftId);
    expect(screen.getByTestId("draft").textContent).toBe(draft.draftId);
  });

  it("keeps pendingNewThread and current() consistent in StrictMode", () => {
    const storage = createMemoryStorage();
    const draft = createNewThreadDraft({ projectPath: "/strict", projectName: "strict" });
    let current: ReturnType<typeof useNewThreadController>;
    function Harness() {
      const controller = useNewThreadController(storage);
      current = controller;
      useLayoutEffect(() => controller.begin(draft), [controller.begin]);
      return <output data-testid="draft">{controller.pendingNewThread?.draftId ?? "missing"}</output>;
    }
    render(<StrictMode><Harness /></StrictMode>);
    expect(current!.current()?.draftId).toBe(draft.draftId);
    expect(screen.getByTestId("draft").textContent).toBe(draft.draftId);
    expect(screen.getByTestId("draft").textContent).toBe(current!.current()?.draftId);
  });

  it("keeps the requestId reference stable across renders while reading the live id", () => {
    const storage = createMemoryStorage();
    const renderCount = { renders: 0 };
    let current: ReturnType<typeof useNewThreadController>;
    function Harness() {
      const controller = useNewThreadController(storage);
      current = controller;
      renderCount.renders += 1;
      const [, bump] = useState(0);
      return (
        <button type="button" data-testid="bump" onClick={() => bump((n) => n + 1)}>
          re-render
        </button>
      );
    }
    render(<Harness />);
    const rendersAtStart = renderCount.renders;
    expect(rendersAtStart).toBeGreaterThan(0);
    const ref = current!.requestId;
    const firstId = ref.current;
    fireEvent.click(screen.getByTestId("bump"));
    const rendersAfterFirstClick = renderCount.renders;
    expect(rendersAfterFirstClick).toBeGreaterThan(rendersAtStart);
    expect(current!.requestId).toBe(ref);
    expect(ref.current).toBe(firstId);

    const draft = createNewThreadDraft({ projectPath: "/repo", projectName: "repo" });
    act(() => { current!.begin(draft); });
    const afterBeginId = ref.current;
    expect(afterBeginId).not.toBe(firstId);
    act(() => { fireEvent.click(screen.getByTestId("bump")); });
    const rendersAfterBeginClick = renderCount.renders;
    expect(rendersAfterBeginClick).toBeGreaterThan(rendersAfterFirstClick);
    expect(current!.requestId).toBe(ref);
    expect(ref.current).toBe(afterBeginId);

    act(() => { current!.invalidate(); });
    const afterInvalidateId = ref.current;
    expect(afterInvalidateId).not.toBe(afterBeginId);
    act(() => { fireEvent.click(screen.getByTestId("bump")); });
    expect(current!.requestId).toBe(ref);
    expect(ref.current).toBe(afterInvalidateId);
  });
});
