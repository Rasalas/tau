// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { revealQueuedMessages } from "./queue-reveal";

afterEach(() => { document.body.innerHTML = ""; });

describe("revealQueuedMessages", () => {
  it("scrolls the queue into view and focuses its first control", () => {
    document.body.innerHTML = `<div id="log"><ol class="queued-messages"><li><button id="grip">Reorder</button><button>Send now</button></li></ol></div>`;
    const list = document.querySelector<HTMLElement>(".queued-messages")!;
    list.scrollIntoView = vi.fn();

    expect(revealQueuedMessages(document.getElementById("log"))).toBe(true);
    expect(list.scrollIntoView).toHaveBeenCalledWith({ block: "nearest" });
    expect(document.activeElement?.id).toBe("grip");
  });

  it("reports a transcript without a queue", () => {
    document.body.innerHTML = `<div id="log"></div>`;
    expect(revealQueuedMessages(document.getElementById("log"))).toBe(false);
    expect(revealQueuedMessages(null)).toBe(false);
  });
});
