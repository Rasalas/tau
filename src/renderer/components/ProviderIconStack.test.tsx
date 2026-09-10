// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIconStack } from "./ProviderIconStack";

afterEach(cleanup);

describe("ProviderIconStack", () => {
  it("shows Pi as the default harness", () => {
    const { getByLabelText } = render(<ProviderIconStack />);
    const stack = getByLabelText("Pi");
    expect(stack.querySelector(".provider-family-pi .provider-mark-mono")).toBeTruthy();
    expect(stack.classList).toContain("single");
  });

  it.each([
    ["anthropic", "Anthropic", "anthropic"],
    ["openai", "OpenAI", "openai"],
    ["google", "Google Gemini", "gemini"],
    ["vertex-ai", "Vertex AI", "vertex-ai"],
    ["opencode-go", "OpenCode Go", "opencode"],
    ["ki:connect", "KI:connect", "ki-connect"],
  ])("maps %s to its model-provider mark", (modelProvider, label, family) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={modelProvider} runtimeProvider="pi" />);
    const stack = getByLabelText(`${label} via Pi`);
    expect(stack.querySelector(`.provider-family-${family} .provider-mark`)).toBeTruthy();
    expect(stack.classList).toContain("stacked");
  });

  it("pairs a non-Pi runtime beside the model provider", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="google" runtimeProvider="opencode" />);
    const stack = getByLabelText("Google Gemini via OpenCode");
    expect(stack.querySelectorAll(".provider-mark")).toHaveLength(2);
    expect(stack.classList).toContain("stacked");
    expect(stack.firstElementChild?.classList).toContain("provider-icon-runtime");
    expect(stack.lastElementChild?.classList).toContain("provider-icon-model");
  });

  it("pairs the Claude Code runtime with the Anthropic provider", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="anthropic" runtimeProvider="claude-code" />);
    const stack = getByLabelText("Anthropic via Claude Code");
    expect(stack.querySelectorAll(".provider-mark")).toHaveLength(2);
    expect(stack.classList).toContain("stacked");
  });

});
