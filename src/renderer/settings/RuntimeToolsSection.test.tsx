// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiRuntimeToolsState } from "../../shared/contracts";
import { HostClientProvider } from "../host-client-context";
import { createFakeHostClient } from "../test-support/fake-host-client";
import { TestProviders } from "../test-support/test-providers";
import { RuntimeToolsSection } from "./RuntimeToolsSection";

afterEach(cleanup);

const STATE: UiRuntimeToolsState = {
  tools: [
    {
      kinds: ["codex"],
      label: "Codex",
      tool: "codex",
      installed: "0.159.0",
      latest: "0.159.0",
      source: "Homebrew cask codex",
      update: "brew upgrade --cask codex",
      behind: { source: "homebrew", latest: "0.159.0", newer: { source: "npm", latest: "0.159.1" } },
      switchSteps: ["brew uninstall --cask codex", "npm install -g @openai/codex@latest"],
    },
    { kinds: ["cursor"], label: "Cursor", tool: "cursor-agent", installed: "2026.09.18", latest: "2026.09.28", source: "its own installer", update: "cursor-agent update" },
    { kinds: ["grok"], label: "Grok", tool: "grok", installed: "1.0.0", source: "unknown", note: "Tau cannot tell what installed it." },
  ],
  log: [{ at: Date.now() - 60_000, label: "OpenCode", action: "update", command: "npm install -g opencode-ai@latest", from: "1.1.0", outcome: "failed", message: "Exited with 1; 1.1.0 stays.", output: "EACCES" }],
};

function renderSection(options: { state?: UiRuntimeToolsState; owner?: boolean } = {}) {
  const runtimeTools = vi.fn(async (action: string, input?: { on?: boolean; kind?: string }) => {
    const state = options.state ?? STATE;
    if (action === "automatic") return { ...state, automatic: input?.on };
    return state;
  });
  const notify = vi.fn();
  const client = createFakeHostClient({ runtimeTools, isOwner: () => options.owner ?? true, isReadOnly: () => false } as never);
  render(<TestProviders><HostClientProvider client={client}><RuntimeToolsSection onNotify={notify} /></HostClientProvider></TestProviders>);
  return { runtimeTools, notify };
}

describe("Settings → Runtimes → Agent tools (K124)", () => {
  it("lists each program with its source and command, a failed run with its output, and turns updating on", async () => {
    const { runtimeTools } = renderSection();
    expect(await screen.findByText("Keep agent tools up to date")).toBeTruthy();
    expect(screen.getByText("brew upgrade --cask codex")).toBeTruthy();
    expect(screen.getByText("2026.09.28 available")).toBeTruthy();
    expect(screen.getByText("Tau cannot tell what installed it.", { exact: false })).toBeTruthy();
    expect(screen.getByText("Exited with 1; 1.1.0 stays.")).toBeTruthy();
    expect(screen.getByText("EACCES")).toBeTruthy();
    fireEvent.click(screen.getByRole("switch", { name: "Keep agent tools up to date" }));
    await waitFor(() => expect(runtimeTools).toHaveBeenCalledWith("automatic", { on: true }));
    fireEvent.click(screen.getByRole("button", { name: "Update now" }));
    await waitFor(() => expect(runtimeTools).toHaveBeenCalledWith("update", { kind: "cursor" }));
  });

  it("says Homebrew lags npm and switches only after the user saw the commands and confirmed", async () => {
    const { runtimeTools } = renderSection();
    expect(await screen.findByText("Homebrew has 0.159.0, npm 0.159.1.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Switch to npm" }));
    expect(screen.getByText("npm install -g @openai/codex@latest")).toBeTruthy();
    expect(runtimeTools).not.toHaveBeenCalledWith("switch", expect.anything());
    fireEvent.click(screen.getByRole("button", { name: "Switch" }));
    await waitFor(() => expect(runtimeTools).toHaveBeenCalledWith("switch", { kind: "codex" }));
  });

  it("refreshes every runtime's version and models", async () => {
    const { runtimeTools, notify } = renderSection();
    fireEvent.click(await screen.findByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(runtimeTools).toHaveBeenCalledWith("refresh"));
    await waitFor(() => expect(notify).toHaveBeenCalledWith("Every runtime was asked for its version and models again."));
  });

  it("changes nothing from a device without Full access, and says why when the host runs no updates", async () => {
    renderSection({ owner: false, state: { ...STATE, blocked: "Safe mode runs no updates." } });
    const toggle = await screen.findByRole("switch", { name: "Keep agent tools up to date" });
    expect(toggle).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Switch to npm" })).toHaveProperty("disabled", true);
  });
});
