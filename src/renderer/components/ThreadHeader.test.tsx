// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

  it("counts the turns of a window that leaves older ones out by the number it was given", () => {
    const windowed = { ...snapshot, messages: [
      { id: "u9", role: "user", text: "ninth", timestamp: 1, turnNumber: 9 },
      { id: "a9", role: "assistant", text: "ok", timestamp: 2 },
      { id: "u10", role: "user", text: "tenth", timestamp: 3 },
    ] } as unknown as HostSnapshot;
    const view = render(<TestProviders><ThreadDetails snapshot={windowed} view={new ThreadViewStore(windowed)} /></TestProviders>);
    expect(view.container.querySelector(".thread-detail-turn")?.textContent).toBe("turn 10");
  });

  it("names no machine where none is given (the desktop, whose kits place it)", () => {
    const view = render(<TestProviders><ThreadDetails snapshot={snapshot} view={new ThreadViewStore(snapshot)} /></TestProviders>);
    expect(view.container.querySelector(".thread-detail")?.textContent).toBe("fix/rail");
  });
});

describe("ThreadHeader", () => {
  it("shows the tools without a stage toggle", () => {
    const { container, rerender } = render(<ThreadHeader
      title={<span className="title-draft">New thread</span>}
      tools={<button type="button">Files</button>}
    />);
    expect(within(screen.getByRole("toolbar", { name: "Tools" })).getByRole("button", { name: "Files" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Show stage" })).toBeNull();
    expect(container.querySelector(".thread-header-separator")).toBeNull();

    rerender(<ThreadHeader title="Thread" />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByRole("toolbar", { name: "Tools" })).toBeNull();
    expect(container.querySelector(".thread-header-separator")).toBeNull();
  });
});
