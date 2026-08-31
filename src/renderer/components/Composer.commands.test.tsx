// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, normalizeSkillInvocation } from "./Composer";

const composerCommands = [
  { name: "skill:tdd", description: "Build features test-first", source: "skill" as const },
  { name: "review", description: "Review staged changes", argumentHint: "[scope]", source: "prompt" as const },
  { name: "reload", description: "Reload resources", source: "extension" as const },
];

const snapshot: HostSnapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Thread",
  models: [],
  thinkingLevel: "medium",
  thinkingLevels: ["medium"],
  messages: [],
  isStreaming: false,
  activeTools: [],
  allTools: [],
  composerCommands,
  extensionCount: 0,
  serviceTier: "standard",
  serviceTierAvailable: false,
};

function renderComposer(onSubmit = vi.fn()) {
  render(<Composer
    snapshot={snapshot}
    queue={[]}
    accessLevel="full"
    contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
    textareaRef={createRef<HTMLTextAreaElement>()}
    onSubmit={onSubmit}
    onAbort={() => {}}
    onCancelQueued={() => {}}
    onSetModel={() => {}}
    onSetThinking={() => {}}
    onSetServiceTier={() => {}}
    onSetAccess={() => {}}
    onCompactContext={() => {}}
    workspaceBusy={false}
    onOpenWorktree={() => {}}
    onCreateWorktree={() => {}}
    onSwitchRef={() => {}}
  />);
  return onSubmit;
}

afterEach(cleanup);

describe("Composer command menu", () => {
  it("shows Pi skills with the $ syntax and sends Pi's canonical /skill: command", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\$ skills/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "$td", selectionStart: 3 } });
    expect(screen.getByRole("listbox", { name: "Skills" })).toBeTruthy();
    expect(screen.getByRole("option", { name: /tdd/u })).toBeTruthy();

    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("$tdd ");
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "$tdd fix the parser", selectionStart: 19 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/skill:tdd fix the parser", []);
  });

  it("finds and executes skills directly from slash", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/td", selectionStart: 3 } });
    expect(screen.getByRole("option", { name: /tdd/u }).textContent).not.toContain("skill:tdd");
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(textarea.value).toBe("/tdd ");

    fireEvent.change(textarea, { target: { value: "/tdd fix the parser", selectionStart: 19 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("/skill:tdd fix the parser", []);
  });

  it("offers prompt templates and extension commands under slash", () => {
    renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "/rev", selectionStart: 4 } });
    const menu = screen.getByRole("listbox", { name: "Commands" });
    expect(menu.textContent).toContain("review");
    expect(menu.textContent).toContain("[scope]");
    expect(menu.textContent).not.toContain("tdd");

    fireEvent.keyDown(textarea, { key: "Tab" });
    expect(textarea.value).toBe("/review ");
  });

  it("leaves unknown and colliding shorthand untouched", () => {
    expect(normalizeSkillInvocation("$missing do this", composerCommands)).toBe("$missing do this");
    expect(normalizeSkillInvocation("/review this", [
      ...composerCommands,
      { name: "skill:review", source: "skill", description: "Review skill" },
    ])).toBe("/review this");
  });
});
