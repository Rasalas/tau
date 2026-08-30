// @vitest-environment jsdom
import { useRef } from "react";
import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { VirtualTranscript } from "./VirtualTranscript";

function Fixture({ messages }: { messages: UiMessage[] }) {
  const ref = useRef<HTMLDivElement>(null);
  return <div ref={ref} style={{ height: 600, overflow: "auto" }}>
    <VirtualTranscript messages={messages} scrollRef={ref} workedMs={{}} isStreaming={false} />
  </div>;
}

describe("virtual transcript", () => {
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
