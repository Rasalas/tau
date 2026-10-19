import { afterEach, describe, expect, it, vi } from "vitest";
import type { ExtensionUiPrompt, ThreadHostEvent } from "../shared/contracts.js";
import { ExtensionUiCoordinator } from "./extension-ui-coordinator.js";

afterEach(() => vi.useRealTimers());

describe("ExtensionUiCoordinator timing", () => {
  it("stamps when it first asked, announces it, and keeps it across a replay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(5_000);
    const events: ThreadHostEvent[] = [];
    const coordinator = new ExtensionUiCoordinator((_thread, event) => events.push(event), () => undefined);
    const prompt: ExtensionUiPrompt = { id: "q1", sessionId: "s1", kind: "confirm", title: "Write the file?" };
    void coordinator.ask(prompt);
    vi.setSystemTime(65_000);
    expect(coordinator.replay()).toMatchObject([{ id: "q1", askedAt: 5_000 }]);
    expect(events[0]).toMatchObject({ type: "extension-ui-prompt", prompt: { id: "q1", askedAt: 5_000 } });
  });

  it("keeps a time the asker already set", () => {
    const coordinator = new ExtensionUiCoordinator(() => undefined, () => undefined);
    void coordinator.ask({ id: "q1", sessionId: "s1", kind: "confirm", title: "Go?", askedAt: 42 });
    expect(coordinator.replay()).toMatchObject([{ askedAt: 42 }]);
  });
});
