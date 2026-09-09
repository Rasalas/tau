// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(screen.getByRole("dialog", { name: "Active Instructions and System Prompt" })).toBeDefined();

    await waitFor(() => {
      expect(inspectSystemPrompt).toHaveBeenCalledWith("thread-1");
      expect(screen.getByText(/You are an expert coding assistant/)).toBeDefined();
    });
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

    // Switch to Base Prompt
    fireEvent.click(screen.getByRole("button", { name: /Base Prompt/i }));
    expect(screen.getByText("/mock/project/.tau/system-prompt.md")).toBeDefined();

    // Switch to Appends
    fireEvent.click(screen.getByRole("button", { name: /Appends/i }));
    expect(screen.getByText("Extra append rule.")).toBeDefined();

    // Switch to Context
    fireEvent.click(screen.getByRole("button", { name: /Project Context/i }));
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
});
