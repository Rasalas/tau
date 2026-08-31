// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, normalizeSkillInvocation } from "./Composer";
import { ComposerScopeStore } from "../composer-scope-store";

const composerCommands = [
  { name: "skill:tdd", description: "Build features test-first", source: "skill" as const, skillCommand: "/skill:tdd" },
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
  supportsImageInput: true,
};

function renderComposer(onSubmit = vi.fn(async () => ({ accepted: true as const })), streaming = false, snapshotOverride: HostSnapshot = snapshot) {
  const scopeStore = new ComposerScopeStore();
  render(<Composer
    scopeStore={scopeStore}
    snapshot={{ ...snapshotOverride, isStreaming: streaming }}
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
    onOpenWorktree={async () => true}
    onCreateWorktree={async () => true}
    onSwitchRef={async () => true}
  />);
  return onSubmit;
}

afterEach(cleanup);

describe("Composer command menu", () => {
  it("shows skills with the $ syntax and sends the user's shorthand unchanged", () => {
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
    expect(onSubmit).toHaveBeenCalledWith("$tdd fix the parser", [], undefined, { source: "skill", name: "tdd", visibleText: "fix the parser", command: "/skill:tdd" });
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
    expect(onSubmit).toHaveBeenCalledWith("/tdd fix the parser", [], undefined, { source: "skill", name: "tdd", visibleText: "fix the parser", command: "/skill:tdd" });
  });

  it("queues Enter and steers with Command-Enter while streaming", async () => {
    const onSubmit = renderComposer(vi.fn(async () => ({ accepted: true as const })), true);
    const textarea = screen.getByPlaceholderText(/queues/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "after this turn", selectionStart: 15 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenLastCalledWith("after this turn", [], "followUp");
    await new Promise((resolve) => setTimeout(resolve, 0));

    fireEvent.change(textarea, { target: { value: "adjust now", selectionStart: 10 } });
    fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenLastCalledWith("adjust now", [], "steer");
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

  it("passes indented command-looking Markdown to the host unchanged", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\/ commands/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "    /tdd keep this code", selectionStart: 23 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("    /tdd keep this code", []);
  });

  it("passes selected skill metadata while preserving instruction indentation", () => {
    const onSubmit = renderComposer();
    const textarea = screen.getByPlaceholderText(/\$ skills/u) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "$td", selectionStart: 3 } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    fireEvent.change(textarea, { target: { value: "$tdd  keep this:\n    code", selectionStart: 25 } });
    fireEvent.keyDown(textarea, { key: "Enter" });

    expect(onSubmit).toHaveBeenCalledWith(
      "$tdd  keep this:\n    code",
      [],
      undefined,
      { source: "skill", name: "tdd", visibleText: " keep this:\n    code", command: "/skill:tdd" },
    );
  });

  it("makes unsupported Claude controls unavailable before invocation", () => {
    renderComposer(vi.fn(), false, {
      ...snapshot,
      backendKind: "claude-code",
      runtimeCapabilities: { skillInvocationDialect: "claude-code" },
      models: [],
      model: undefined,
      thinkingLevel: "off",
      thinkingLevels: ["off"],
      serviceTierAvailable: false,
    });

    expect(screen.getByRole("button", { name: "Model selection unavailable" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Reasoning controls unavailable" })).toHaveProperty("disabled", true);

    fireEvent.click(screen.getByRole("button", { name: /full access/u }));
    const ask = screen.getByRole("menuitem", { name: /ask before edits/u });
    expect(ask).toHaveProperty("disabled", true);
    expect(ask.getAttribute("title")).toContain("interactive approvals");
  });
});
