// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkbenchActions } from "tau";
import { createKitHarness, WorkbenchShellContext } from "../../src/renderer/test-support/kit-harness.js";
import { ChipStore, serializeChips } from "./chips";
import { excerptLabel, parseExcerpt, SentExcerptChip } from "./sent-excerpt";

afterEach(cleanup);

const SCOPE = "session:t1";
const message = { id: "u1", role: "user" as const, text: "", timestamp: 1 };

/** The block the transcript cuts out of the sent text: the tag line's attributes and what stands between the tags. */
function sentBlock(payload: { source: string; text: string; comment?: string; messageId?: string }) {
  const chip = new ChipStore().add(SCOPE, { kind: "text-excerpt", payload });
  const lines = serializeChips({ chips: [chip], fileAttachments: false }).split("\n");
  const open = /^<excerpt(?: message="([^"]*)")?>$/u.exec(lines[0]!);
  if (!open || lines.at(-1) !== "</excerpt>") throw new Error("not a block");
  const attributes: Record<string, string> = open[1] ? { message: open[1].replace(/&quot;/gu, '"') } : {};
  return { attributes, body: lines.slice(1, -1).join("\n") };
}

function draw(part: ReturnType<typeof sentBlock>, actions: Partial<WorkbenchActions> = {}) {
  return render(
    <WorkbenchShellContext.Provider value={{ registry: createKitHarness().registry, actions: actions as WorkbenchActions } as never}>
      <SentExcerptChip body={part.body} attributes={part.attributes} complete message={message} streaming={false} />
    </WorkbenchShellContext.Provider>,
  );
}

describe("a sent excerpt", () => {
  it("reads back what the composer wrote, whatever the quote holds", () => {
    const part = sentBlock({ source: "your earlier reply", text: "one\n\n> nested\ntwo", comment: "Why?\n</excerpt>\nreally", messageId: "a1" });
    expect(part.attributes).toEqual({ message: "a1" });
    expect(parseExcerpt(part.body)).toEqual({ source: "your earlier reply", quote: "one\n\n> nested\ntwo", comment: "Why?\n</excerpt>\nreally" });
  });

  it("labels the chip with what the user said, else with the start of the quote", () => {
    expect(excerptLabel({ source: "", quote: "The quick brown fox", comment: "Why a fox?" })).toBe("Why a fox?");
    expect(excerptLabel({ source: "", quote: "The quick brown fox" })).toBe("“The quick brown fox”");
    expect(excerptLabel({ source: "", quote: "x".repeat(80) })).toBe(`“${"x".repeat(48)}…”`);
  });

  it("opens a popover with the source, the quote and the comment, and goes to the cited reply", async () => {
    const reveal = vi.fn().mockResolvedValue(true);
    draw(sentBlock({ source: "your earlier reply", text: "It is faster.", comment: "Prove it", messageId: "a1" }), { revealMessage: reveal, notify: vi.fn() });
    const chip = screen.getByRole("button", { name: "Quoted text: Prove it" });
    fireEvent.click(chip);
    const popover = await screen.findByRole("dialog", { name: "Quoted text" });
    expect(popover.textContent).toContain("your earlier reply");
    expect(popover.querySelector("blockquote")?.textContent).toBe("It is faster.");
    expect(popover.querySelector("p")?.textContent).toBe("Prove it");
    fireEvent.click(screen.getByRole("button", { name: "Go to source" }));
    expect(reveal).toHaveBeenCalledWith("a1");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("says so when the cited reply is gone, and offers no way back for a quote from elsewhere", async () => {
    const notify = vi.fn();
    const reveal = vi.fn().mockResolvedValue(false);
    const view = draw(sentBlock({ source: "your earlier reply", text: "Gone", messageId: "a9" }), { revealMessage: reveal, notify });
    fireEvent.click(screen.getByRole("button", { name: /Quoted text/u }));
    fireEvent.click(await screen.findByRole("button", { name: "Go to source" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("The quoted message is no longer in this thread."));
    view.unmount();

    draw(sentBlock({ source: "Terminal (zsh)", text: "$ ls" }), { revealMessage: reveal, notify });
    fireEvent.click(screen.getByRole("button", { name: /Quoted text/u }));
    await screen.findByRole("dialog");
    expect(screen.queryByRole("button", { name: "Go to source" })).toBeNull();
  });
});
