// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerNotice, SetupNotice } from "./ComposerNotice";

afterEach(cleanup);

describe("ComposerNotice (2c)", () => {
  it.each(["Failed to authenticate: OAuth session expired and could not be refreshed", "Compaction failed: Error during compaction: Failed to authenticate: OAuth session expired and could not be refreshed"])("directs an expired login to provider settings instead of retrying: %s", (error) => {
    const openSettings = vi.fn();
    render(<ComposerNotice sessionId="s" error={error} provider="anthropic" onReplaceKey={openSettings} onRetry={vi.fn()} />);
    expect(screen.getByRole("status").textContent).toContain("Sign in again");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open provider settings" }));
    expect(openSettings).toHaveBeenCalledOnce();
  });
  it("names a refused key and offers to replace it", () => {
    const onReplaceKey = vi.fn();
    const onSwitchModel = vi.fn();
    render(<ComposerNotice sessionId="s" error={'401 {"message":"Incorrect API key provided"}'} provider="openai" onReplaceKey={onReplaceKey} onSwitchModel={onSwitchModel} />);
    expect(screen.getByRole("status").textContent).toContain("OpenAI rejected the API key");
    expect(screen.getByRole("status").querySelector("p")?.textContent).toBe("401 · Incorrect API key provided");
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch model" }));
    expect(onReplaceKey).toHaveBeenCalledOnce();
    expect(onSwitchModel).toHaveBeenCalledOnce();
  });

  it("draws a rate limit in amber and retries on request", () => {
    const onRetry = vi.fn();
    const { container } = render(<ComposerNotice sessionId="s" error="429 Too Many Requests" onReplaceKey={() => undefined} onRetry={onRetry} />);
    expect(container.querySelector(".composer-notice.warn strong")?.textContent).toBe("Rate limit");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("says any other failure stopped the turn, without Retry on a read-only device", () => {
    const { container } = render(<ComposerNotice sessionId="s" error="stream disconnected" onReplaceKey={() => undefined} />);
    expect(container.querySelector(".composer-notice.fail strong")?.textContent).toBe("Stopped with an error");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not blame the key when the thread has no model, and drops Pi's slash command and paths", () => {
    const onReplaceKey = vi.fn();
    const error = "No model selected.\n\nUse /login to log into a provider via OAuth or API key. See:\n  /Users/me/.pi/docs/providers.md\n  /Users/me/.pi/docs/models.md\n\nThen use /model to select a model.";
    const { container } = render(<ComposerNotice sessionId="s" error={error} provider="openai" onReplaceKey={onReplaceKey} onSwitchModel={() => undefined} />);
    expect(container.querySelector(".composer-notice strong")?.textContent).toBe("No model selected");
    const text = screen.getByRole("status").textContent ?? "";
    expect(text).not.toMatch(/rejected|Replace key|\/login|\.md/u);
    expect(screen.queryByRole("button", { name: "Replace key" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open Runtimes" }));
    expect(onReplaceKey).toHaveBeenCalledOnce();
  });
});

describe("SetupNotice", () => {
  const acme = { kind: "acme", label: "Acme" };

  it("names a signed-out runtime and leads to its card, or to another runtime", () => {
    const onOpen = vi.fn();
    const onSwitchRuntime = vi.fn();
    render(<SetupNotice setup={{ state: "signed-out", backend: acme }} onOpen={onOpen} onSwitchRuntime={onSwitchRuntime} />);
    expect(screen.getByRole("status").querySelector("strong")?.textContent).toBe("Acme is signed out");
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(screen.getByRole("button", { name: "Switch runtime" }));
    expect(onOpen).toHaveBeenCalledOnce();
    expect(onSwitchRuntime).toHaveBeenCalledOnce();
  });

  it("says Pi lacks a model provider, not an account", () => {
    render(<SetupNotice setup={{ state: "signed-out", backend: { kind: "pi", label: "Pi" } }} onOpen={() => undefined} />);
    expect(screen.getByRole("status").querySelector("strong")?.textContent).toBe("Pi has no model provider yet");
    expect(screen.getByRole("button", { name: "Add a provider" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Switch runtime" })).toBeNull();
  });

  it("offers the card of a runtime that is not installed", () => {
    render(<SetupNotice setup={{ state: "not-installed", backend: acme }} onOpen={() => undefined} />);
    expect(screen.getByRole("status").querySelector("strong")?.textContent).toBe("Acme is not installed");
    expect(screen.getByRole("button", { name: "Set up" })).toBeTruthy();
  });

  it("says no provider is set up when nothing can start a thread", () => {
    const onOpen = vi.fn();
    render(<SetupNotice setup={{ state: "none" }} onOpen={onOpen} />);
    expect(screen.getByRole("status").querySelector("strong")?.textContent).toBe("No provider is set up yet");
    fireEvent.click(screen.getByRole("button", { name: "Open Runtimes" }));
    expect(onOpen).toHaveBeenCalledOnce();
  });
});
