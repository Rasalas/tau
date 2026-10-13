// @vitest-environment jsdom
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ActivityStreamScenario, { activityStreamFixture } from "./RendererBenchmarkActivityStream";

describe("historical activity stream benchmark", () => {
  it("constructs 2,000 turns with 1,000 settled history entries", () => {
    const store = activityStreamFixture(2_000, 1_000);
    expect(store.getTranscript().messages).toHaveLength(4_000);
    expect(store.getToolView().turnActivityHistory).toHaveLength(1_000);
    expect(store.getToolView().turnActivityHistory.every((entry) => entry.status === "completed")).toBe(true);
  });

  it("drives the store for all 40 frames while displaying an older turn", async () => {
    const onTick = vi.fn();
    const onFinished = vi.fn();
    const view = render(<ActivityStreamScenario turns={2_000} historyEntries={1_000} bytes={153_600} updates={40} onTick={onTick} onFinished={onFinished} />);
    await waitFor(() => {
      expect(onFinished).toHaveBeenCalledOnce();
      expect(onFinished).toHaveBeenCalledWith(153_600);
      expect(onTick).toHaveBeenCalledTimes(40);
      expect(view.container.querySelector('[data-message-id="message-8"]')).toBeTruthy();
      expect(view.container.querySelector('[data-message-id="message-3999"]')).toBeNull();
    });
  });
});
