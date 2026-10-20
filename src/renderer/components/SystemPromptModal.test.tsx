// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { SystemPromptModal } from "./SystemPromptModal";
import type { SystemPromptInspection } from "../../shared/contracts";

afterEach(cleanup);

const mockInspection: SystemPromptInspection = {
  effectivePrompt: "You are an expert coding assistant.\n\n<project_context>\nAlways test.\n</project_context>",
  basePrompt: "You are an expert coding assistant.",
  basePromptSource: "/mock/project/.tau/system-prompt.md",
  appends: [
    {
      text: "Extra append rule.",
      source: "/mock/project/.tau/append-system-prompt.md",
    },
  ],
  contextFiles: [
    {
      path: "/mock/project/AGENTS.md",
      content: "# Agents rules\nAlways test thoroughly.",
    },
  ],
};

describe("SystemPromptModal", () => {
  it("loads and displays the effective prompt", async () => {
    const onClose = vi.fn();
    const inspectSystemPrompt = vi.fn().mockResolvedValue(mockInspection);
    const fakeClient = createFakeHostClient({ inspectSystemPrompt });

    render(
      <HostClientProvider client={fakeClient}>
        <SystemPromptModal onClose={onClose} threadId="thread-1" />
      </HostClientProvider>,
    );

    expect(screen.getByRole("dialog", { name: "Active instructions and system prompt" })).toBeDefined();

    await waitFor(() => {
      expect(inspectSystemPrompt).toHaveBeenCalledWith("thread-1");
      expect(screen.getByText(/You are an expert coding assistant/)).toBeDefined();
    });
  });

  it("retries a failed read inside the accessible dialog", async () => {
    const inspectSystemPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("Instructions unavailable"))
      .mockResolvedValueOnce(mockInspection);
    render(
      <HostClientProvider client={createFakeHostClient({ inspectSystemPrompt })}>
        <SystemPromptModal onClose={() => {}} threadId="thread-1" />
      </HostClientProvider>,
    );
    expect((await screen.findByRole("alert")).textContent).toContain("Could not read the instructions");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByText(/You are an expert coding assistant/);
    expect(inspectSystemPrompt).toHaveBeenCalledTimes(2);
    expect(inspectSystemPrompt).toHaveBeenLastCalledWith("thread-1");
    expect(screen.getByRole("tabpanel", { name: /Effective prompt/i })).toBeDefined();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("navigates through tabs", async () => {
    const inspectSystemPrompt = vi.fn().mockResolvedValue(mockInspection);
    const fakeClient = createFakeHostClient({ inspectSystemPrompt });

    render(
      <HostClientProvider client={fakeClient}>
        <SystemPromptModal onClose={() => {}} />
      </HostClientProvider>,
    );

    await waitFor(() => {
      expect(screen.getByText(/You are an expert coding assistant/)).toBeDefined();
    });

    expect(screen.getByRole("tab", { name: /Effective prompt/i }).getAttribute("aria-selected")).toBe("true");

    // Switch to Base Prompt
    fireEvent.click(screen.getByRole("tab", { name: /Base prompt/i }));
    expect(screen.getByRole("tab", { name: /Base prompt/i }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: /Effective prompt/i }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tabpanel", { name: /Base prompt/i })).toBeDefined();
    expect(screen.getByText("/mock/project/.tau/system-prompt.md")).toBeDefined();

    // The arrow keys move along the tabs and focus the one they select.
    fireEvent.keyDown(screen.getByRole("tab", { name: /Base prompt/i }), { key: "ArrowRight" });
    const appends = screen.getByRole("tab", { name: /Appends/i });
    expect(appends.getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(appends);
    expect(screen.getByText("Extra append rule.")).toBeDefined();

    // Switch to Context
    fireEvent.click(screen.getByRole("tab", { name: /Project context/i }));
    expect(screen.getByText("/mock/project/AGENTS.md")).toBeDefined();
    expect(screen.getByText(/# Agents rules/)).toBeDefined();
  });

  it("calls onClose when close button is clicked", async () => {
    const onClose = vi.fn();
    const fakeClient = createFakeHostClient();

    render(
      <HostClientProvider client={fakeClient}>
        <SystemPromptModal onClose={onClose} />
      </HostClientProvider>,
    );

    const closeButtons = screen.getAllByRole("button", { name: /Close/i });
    fireEvent.click(closeButtons[0]);
    expect(onClose).toHaveBeenCalled();
  });

  it("takes focus, keeps Tab inside and closes on Escape", async () => {
    const onClose = vi.fn();
    render(
      <HostClientProvider client={createFakeHostClient({ inspectSystemPrompt: vi.fn().mockResolvedValue(mockInspection) })}>
        <SystemPromptModal onClose={onClose} />
      </HostClientProvider>,
    );

    const dialog = screen.getByRole("dialog", { name: "Active instructions and system prompt" });
    await screen.findByText(/You are an expert coding assistant/);
    expect(dialog.contains(document.activeElement)).toBe(true);
    const last = screen.getAllByRole("button", { name: "Close" }).at(-1)!;
    act(() => { last.focus(); });
    fireEvent.keyDown(last, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(last);

    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
