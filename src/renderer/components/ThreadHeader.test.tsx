// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostSnapshot } from "../../shared/contracts";
import { ThreadViewStore } from "../../workbench/thread-view-store";
import { TestProviders } from "../test-support/test-providers";
import { ThreadDetails, ThreadHeader } from "./ThreadHeader";

afterEach(cleanup);

const snapshot = {
  cwd: "/project",
  sessionId: "session",
  sessionTitle: "Fix the rail",
  projectLabel: "fix/rail",
  models: [],
  model: { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
  thinkingLevel: "medium",
  thinkingLevels: [],
  messages: [{ id: "u1", role: "user", text: "go" }],
  isStreaming: false,
  activeTools: [],
  allTools: [],
  extensionCount: 0,
  supportsImageInput: false,
} as unknown as HostSnapshot;

describe("the thread's sub-line", () => {
  it("names the machine first where it is given, then branch, model and turn, each marked for the phone's bar", () => {
    const view = render(<TestProviders><ThreadDetails snapshot={snapshot} view={new ThreadViewStore(snapshot)} machine="MacBook Pro" /></TestProviders>);
    const details = [...view.container.querySelectorAll(".thread-detail")];
    expect(details.map((detail) => detail.textContent)).toEqual(["MacBook Pro", "fix/rail", "GPT-5.6 Luna", "turn 1"]);
    // A narrow phone bar drops the turn (and the cost) and keeps the model's name whole (profile-compact.css).
    expect(details[2]?.classList.contains("thread-detail-model")).toBe(true);
    expect(details[3]?.classList.contains("thread-detail-turn")).toBe(true);
  });

  it("names no machine where none is given (the desktop, whose kits place it)", () => {
    const view = render(<TestProviders><ThreadDetails snapshot={snapshot} view={new ThreadViewStore(snapshot)} /></TestProviders>);
    expect(view.container.querySelector(".thread-detail")?.textContent).toBe("fix/rail");
  });
});

describe("ThreadHeader", () => {
  it("puts the stage's tools before its toggle while the stage is hidden, set off by a rule (design 1k)", () => {
    const { container, rerender } = render(<ThreadHeader
      title={<span className="title-draft">New thread</span>}
      tools={<button type="button">Files</button>}
      stage={{ shown: false, onToggle: vi.fn() }}
    />);
    const header = container.querySelector(".thread-header") as HTMLElement;
    expect(within(screen.getByRole("toolbar", { name: "Tools" })).getByRole("button", { name: "Files" })).toBeTruthy();
    expect([...header.children].map((child) => child.className).slice(-3)).toEqual(["thread-header-tools", "thread-header-separator", "stage-tool"]);

    rerender(<ThreadHeader title="Thread" stage={{ shown: true, onToggle: vi.fn() }} />);
    expect(screen.queryByRole("toolbar", { name: "Tools" })).toBeNull();
    expect(container.querySelector(".thread-header-separator")).toBeNull();
  });
});
