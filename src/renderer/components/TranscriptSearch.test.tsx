// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UiMessage } from "../../shared/contracts";
import { FIND_DEBOUNCE_MS, TranscriptSearch } from "./TranscriptSearch";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { cleanup(); vi.useRealTimers(); });

const message = (id: string, text: string, role: UiMessage["role"] = "assistant"): UiMessage => ({ id, role, text, timestamp: 1 });
const loaded = [message("m3", "quartz three"), message("m4", "nothing"), message("m5", "more Quartz")];

async function type(query: string) {
  fireEvent.change(screen.getByPlaceholderText("Find in transcript…"), { target: { value: query } });
  await act(async () => { await vi.advanceTimersByTimeAsync(FIND_DEBOUNCE_MS); });
}
const count = () => screen.getByRole("search").querySelector(".search-count")!.textContent;
const press = (key: string, shiftKey = false) => fireEvent.keyDown(screen.getByPlaceholderText("Find in transcript…"), { key, shiftKey });

describe("TranscriptSearch", () => {
  it("without a finder it searches the loaded turns and starts at the newest match", async () => {
    const onJump = vi.fn();
    render(<TranscriptSearch messages={loaded} onJump={onJump} onClose={() => undefined} />);
    await type("QUARTZ");
    expect(onJump).toHaveBeenLastCalledWith("m5");
    expect(count()).toBe("1 of 2");
    press("Enter");
    expect(onJump).toHaveBeenLastCalledWith("m3");
    expect(count()).toBe("2 of 2");
    press("Enter");
    expect(onJump).toHaveBeenLastCalledWith("m5");
    press("Enter", true);
    expect(onJump).toHaveBeenLastCalledWith("m3");
  });

  it("takes the whole thread's answer once it arrives and keeps its place while the match is in it", async () => {
    const onJump = vi.fn();
    const find = vi.fn(async () => ["m0", "m3", "m5"]);
    render(<TranscriptSearch messages={loaded} find={find} onJump={onJump} onClose={() => undefined} />);
    await type("quartz");
    expect(find).toHaveBeenCalledWith("quartz");
    expect(count()).toBe("1 of 3");
    expect(onJump).toHaveBeenCalledTimes(1);
    expect(onJump).toHaveBeenLastCalledWith("m5");
    press("Enter");
    press("Enter");
    // m0 is on an older page that is not loaded: the jump names it all the same.
    expect(onJump).toHaveBeenLastCalledWith("m0");
    expect(count()).toBe("3 of 3");
  });

  it("shows the loaded matches with a plus while the thread is asked, and 0 matches only after", async () => {
    let answer!: (ids: string[]) => void;
    const find = vi.fn(() => new Promise<string[]>((resolve) => { answer = resolve; }));
    render(<TranscriptSearch messages={loaded} find={find} onJump={vi.fn()} onClose={() => undefined} />);
    await type("quartz");
    expect(count()).toBe("1 of 2+");
    await type("absent");
    expect(count()).toBe("Searching…");
    await act(async () => { answer([]); });
    expect(count()).toBe("0 matches");
  });

  it("falls back to the loaded turns when the finder fails", async () => {
    const onJump = vi.fn();
    render(<TranscriptSearch messages={loaded} find={async () => { throw new Error("host gone"); }} onJump={onJump} onClose={() => undefined} />);
    await type("quartz");
    expect(count()).toBe("1 of 2");
    expect(onJump).toHaveBeenLastCalledWith("m5");
  });

  it("says Loading… while a jump waits for older turns, and tells the viewport the query and message", async () => {
    let arrive!: (found: boolean) => void;
    const onJump = vi.fn(() => new Promise<boolean>((resolve) => { arrive = resolve; }));
    const onActive = vi.fn();
    render(<TranscriptSearch messages={loaded} onJump={onJump} onActive={onActive} onClose={() => undefined} />);
    await type("quartz");
    expect(count()).toBe("Loading…");
    await act(async () => { arrive(true); });
    expect(count()).toBe("1 of 2");
    expect(onActive).toHaveBeenLastCalledWith("quartz", "m5");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<TranscriptSearch messages={loaded} onJump={vi.fn()} onClose={onClose} />);
    press("Escape");
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("lowercases only the message a streamed frame replaced", async () => {
    const history = Array.from({ length: 2_000 }, (_, index) => message(`h${index}`, `Settled ${index}`));
    const view = render(<TranscriptSearch messages={[...history, message("live", "Quartz")]} onJump={vi.fn()} onClose={() => undefined} />);
    await type("quartz");
    expect(count()).toBe("1 of 1");
    const lower = vi.spyOn(String.prototype, "toLowerCase");
    try {
      view.rerender(<TranscriptSearch messages={[...history, message("live", "Quartz grows")]} onJump={vi.fn()} onClose={() => undefined} />);
      // React lowercases names of its own; the settled history alone would be 2,000 calls.
      expect(lower.mock.calls.length).toBeLessThan(1_000);
    } finally {
      lower.mockRestore();
    }
    expect(count()).toBe("1 of 1");
  });
});
