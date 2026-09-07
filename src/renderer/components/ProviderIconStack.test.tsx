// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIconStack, hasProviderMark } from "./ProviderIconStack";

afterEach(cleanup);

describe("ProviderIconStack", () => {
  it("does not show Pi or Tau as a provider", () => {
    const { container } = render(<ProviderIconStack runtimeProvider="pi" />);
    expect(container.querySelector(".provider-icon-stack")).toBeNull();
  });

  it.each([
    ["anthropic", "Claude"],
    ["openai", "OpenAI"],
    ["google", "Google Gemini"],
    ["opencode", "OpenCode"],
    ["ki:connect", "KI:connect"],
  ])("maps %s to its model-provider icon", (modelProvider, label) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={modelProvider} runtimeProvider="pi" />);
    const stack = getByLabelText(label);
    expect(stack.querySelectorAll("img")).toHaveLength(1);
    expect(stack.classList).toContain("single");
  });

  it("overlaps a non-Pi gateway behind the model provider", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="google" runtimeProvider="opencode" />);
    const stack = getByLabelText("Google Gemini via OpenCode");
    expect(stack.querySelectorAll("img")).toHaveLength(2);
    expect(stack.classList).toContain("stacked");
  });

  it("keeps the Claude Code logo behind Claude: same family, different program", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="anthropic" runtimeProvider="claude-code" />);
    const stack = getByLabelText("Claude via Claude Code");
    expect(stack.querySelectorAll("img")).toHaveLength(2);
    expect(stack.classList).toContain("stacked");
  });

  it("knows which providers have a mark of their own", () => {
    expect(hasProviderMark("antigravity")).toBe(true);
    expect(hasProviderMark("claude-code")).toBe(true);
    expect(hasProviderMark("pi")).toBe(false);
    expect(hasProviderMark(undefined)).toBe(false);
  });
});
