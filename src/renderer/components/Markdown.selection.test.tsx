// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

afterEach(() => {
  cleanup();
  document.getSelection()?.removeAllRanges();
});

describe("inline code selection", () => {
  it("selects a complete command with punctuation and spaces on double-click", () => {
    render(<Markdown>{"Run `migration-gate --dry-run` first."}</Markdown>);
    fireEvent.doubleClick(screen.getByText("migration-gate --dry-run"));
    expect(document.getSelection()?.toString()).toBe("migration-gate --dry-run");
  });

  it("leaves fenced code selection to the browser", () => {
    const { container } = render(<Markdown>{"Run `migration-gate --dry-run` first.\n\n```text\nfenced-block word\n```"}</Markdown>);
    fireEvent.doubleClick(screen.getByText("migration-gate --dry-run"));
    const selected = document.getSelection()!.getRangeAt(0).cloneRange();
    fireEvent.doubleClick(container.querySelector("pre code")!);
    // jsdom does not perform native word selection; the fence must leave the range alone.
    const after = document.getSelection()!.getRangeAt(0);
    expect(after.startContainer).toBe(selected.startContainer);
    expect(after.endContainer).toBe(selected.endContainer);
    expect(after.toString()).toBe("migration-gate --dry-run");
  });
});
