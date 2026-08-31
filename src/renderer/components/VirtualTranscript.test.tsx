// @vitest-environment jsdom
import { useRef, type ReactNode } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { VirtualTranscript } from "./VirtualTranscript";

function Fixture({ messages, activity, activityAfterMessageId, activities }: {
  messages: UiMessage[];
  activity?: ReactNode;
  activityAfterMessageId?: string;
  activities?: Array<{ id: string; afterMessageId?: string; content: ReactNode; fallbackToTail?: boolean }>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} style={{ height: 600, overflow: "auto" }}>
    <VirtualTranscript
      messages={messages}
      scrollRef={ref}
      isStreaming={false}
      activity={activity}
      activityAfterMessageId={activityAfterMessageId}
      activities={activities}
    />
  </div>;
}

describe("virtual transcript", () => {
  it("places aggregated tool activity between its anchor and the later reply", async () => {
    const messages: UiMessage[] = [
      { id: "user", role: "user", text: "Do the work", timestamp: 1 },
      { id: "assistant", role: "assistant", text: "Done", timestamp: 2 },
    ];
    const view = render(<Fixture
      messages={messages}
      activity={<div>3 tool steps</div>}
      activityAfterMessageId="user"
    />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(2));

    expect(Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent)).toEqual([
      expect.stringMatching(/Do the work.*3 tool steps/u),
      expect.stringContaining("Done"),
    ]);
  });

  it("keeps historical activities anchored to their own turns", async () => {
    const messages: UiMessage[] = [
      { id: "first", role: "user", text: "First", timestamp: 1 },
      { id: "first-reply", role: "assistant", text: "Finished first", timestamp: 2 },
      { id: "second", role: "user", text: "Second", timestamp: 3 },
    ];
    const view = render(<Fixture messages={messages} activities={[
      { id: "first-tasks", afterMessageId: "first", content: <div>2/2 tasks</div> },
      { id: "second-tasks", afterMessageId: "second", content: <div>0/1 tasks</div> },
    ]} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(3));
    expect(Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent)).toEqual([
      expect.stringMatching(/First.*2\/2 tasks/u),
      expect.stringContaining("Finished first"),
      expect.stringMatching(/Second.*0\/1 tasks/u),
    ]);
  });

  it("resolves persisted entry anchors after message ids are remapped", async () => {
    const messages: UiMessage[] = [
      { id: "rendered-user", sourceEntryId: "persisted-user", role: "user", text: "Persisted request", timestamp: 1 },
      { id: "rendered-answer", sourceEntryId: "persisted-answer", role: "assistant", text: "Persisted answer", timestamp: 2 },
      { id: "later", role: "user", text: "Later request", timestamp: 3 },
    ];
    const view = render(<Fixture messages={messages} activities={[
      { id: "checkpoint", afterMessageId: "persisted-answer", content: <div>turn changes</div> },
    ]} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row")).toHaveLength(3));
    expect(Array.from(view.container.querySelectorAll(".virtual-transcript-row")).map((row) => row.textContent)).toEqual([
      expect.stringContaining("Persisted request"),
      expect.stringMatching(/Persisted answer.*turn changes/u),
      expect.stringContaining("Later request"),
    ]);
  });

  it("keeps message alignment working through the virtualization wrapper", async () => {
    const message: UiMessage = { id: "user", role: "user", text: "Right aligned", timestamp: 1 };
    const view = render(<Fixture messages={[message]} />);
    const row = await waitFor(() => view.container.querySelector<HTMLElement>(".virtual-transcript-row"));

    expect(row).not.toBeNull();
    expect(row?.style.display).toBe("flex");
    expect(row?.style.flexDirection).toBe("column");
  });

  it("keeps a thousand loaded turns out of the DOM", async () => {
    Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 600 });
    HTMLElement.prototype.getBoundingClientRect = function () {
      const height = this.classList.contains("virtual-transcript-row") ? 180 : 600;
      return { x: 0, y: 0, top: 0, left: 0, right: 780, bottom: height, width: 780, height, toJSON: () => ({}) };
    };
    const messages: UiMessage[] = Array.from({ length: 1_000 }, (_, index) => ({
      id: `message-${index}`,
      role: index % 2 ? "assistant" : "user",
      text: `Turn ${index}`,
      timestamp: index,
    }));
    const view = render(<Fixture messages={messages} />);
    await waitFor(() => expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeGreaterThan(0));
    expect(view.container.querySelectorAll(".virtual-transcript-row").length).toBeLessThan(40);
  });
});
