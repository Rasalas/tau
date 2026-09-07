// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { Composer, type ComposerRuntimeChoice } from "./Composer";
import { ComposerScopeStore } from "../../workbench/composer-scope-store";
import { TestProviders } from "../test-support/test-providers";

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
  extensionCount: 0,
};

function renderComposer(runtimeChoice?: ComposerRuntimeChoice) {
  render(<TestProviders>
    <Composer
      scopeStore={new ComposerScopeStore()}
      snapshot={snapshot}
      queue={[]}
      contextBreakdown={{ system: 0, messages: 0, toolOutput: 0 }}
      textareaRef={createRef<HTMLTextAreaElement>()}
      onSubmit={vi.fn(async () => ({ accepted: true as const }))}
      onAbort={() => {}}
      onCancelQueued={() => {}}
      onSteerQueued={() => {}}
      onReorderQueue={() => {}}
      onSetModel={() => {}}
      onSetThinking={() => {}}
      onCompactContext={() => {}}
      runtimeChoice={runtimeChoice}
    />
  </TestProviders>);
}

afterEach(cleanup);

describe("composer runtime chip", () => {
  it("is absent for a thread that already exists", () => {
    renderComposer();
    expect(screen.queryByLabelText(/^Runtime:/u)).toBeNull();
  });

  it("names the runtime of the next thread and offers the others", () => {
    const onSelect = vi.fn();
    renderComposer({ kind: "acme", backends: [{ kind: "pi", label: "Pi" }, { kind: "acme", label: "Acme Agent" }], onSelect });
    fireEvent.click(screen.getByLabelText("Runtime: Acme Agent"));
    fireEvent.click(screen.getByRole("menuitem", { name: /Pi/u }));
    expect(onSelect).toHaveBeenCalledWith("pi");
  });
});
