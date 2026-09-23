// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ProviderIconStack, monogram, providerLabel } from "./ProviderIconStack";

afterEach(cleanup);

describe("ProviderIconStack", () => {
  it("shows Pi only where nothing else stands for the thread", () => {
    const { getByLabelText } = render(<ProviderIconStack runtimeProvider="pi" />);
    const stack = getByLabelText("Pi");
    expect(stack.querySelector(".provider-family-pi .provider-mark-mono")).toBeTruthy();
    expect(stack.classList).toContain("single");
    cleanup();
    expect(render(<ProviderIconStack />).container.firstChild).toBeNull();
  });

  it.each([
    ["anthropic", "Anthropic", "anthropic"],
    ["openai", "OpenAI", "openai"],
    ["google", "Google Gemini", "gemini"],
    ["vertex-ai", "Vertex AI", "vertex-ai"],
    ["opencode-go", "OpenCode Go", "opencode"],
    ["cursor", "Cursor", "cursor"],
    ["ki:connect", "KI:connect", "ki-connect"],
  ])("maps %s to its model-provider mark, without Pi's", (modelProvider, label, family) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={modelProvider} runtimeProvider="pi" />);
    const stack = getByLabelText(label);
    expect(stack.querySelector(`.provider-family-${family} .provider-mark`)).toBeTruthy();
    expect(stack.querySelector(".provider-family-pi")).toBeNull();
    expect(stack.classList).toContain("single");
  });

  it.each([
    ["openrouter", "OpenRouter", "openrouter"],
    ["deepseek", "DeepSeek", "deepseek"],
    ["xai", "xAI", "xai"],
    ["mistral", "Mistral", "mistral"],
    ["amazon-bedrock", "Amazon Bedrock", "bedrock"],
    ["zai-coding-cn", "zai-coding-cn", "zai"],
    ["google-vertex", "Vertex AI", "vertex-ai"],
  ])("gives %s a mark of its own", (modelProvider, label, family) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={modelProvider} />);
    expect(getByLabelText(label).querySelector(`.provider-family-${family} .provider-mark`)).toBeTruthy();
  });

  it("draws a provider without a mark as its monogram", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="ant-ling" />);
    expect(getByLabelText("ant-ling").querySelector(".provider-icon-fallback")?.textContent).toBe("AL");
    expect(providerLabel("radius")).toBe("radius");
    expect(monogram("radius")).toBe("R");
    expect(monogram("  ")).toBe("·");
  });

  it("names itself in a native title, the tooltip layer, or not at all", () => {
    const { getByLabelText, rerender } = render(<ProviderIconStack modelProvider="openai" />);
    expect(getByLabelText("OpenAI").getAttribute("title")).toBe("OpenAI");
    rerender(<ProviderIconStack modelProvider="openai" hint={{ side: "left" }} name="OpenAI (work)" />);
    const tipped = getByLabelText("OpenAI (work)");
    expect(tipped.getAttribute("data-tooltip")).toBe("OpenAI (work)");
    expect(tipped.getAttribute("data-tooltip-side")).toBe("left");
    expect(tipped.hasAttribute("title")).toBe(false);
    rerender(<ProviderIconStack modelProvider="openai" hint={false} />);
    const quiet = getByLabelText("OpenAI");
    expect(quiet.hasAttribute("title") || quiet.hasAttribute("data-tooltip")).toBe(false);
  });

  it("draws a runtime instance with its program's mark", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="openai" runtimeProvider="codex@work" />);
    const stack = getByLabelText("OpenAI via Codex");
    expect(stack.querySelector(".provider-family-codex .provider-mark")).toBeTruthy();
    cleanup();
    expect(render(<ProviderIconStack runtimeProvider="claude-code@second" />).getByLabelText("Claude Code")).toBeTruthy();
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

  it("gives the Codex runtime a mark of its own beside OpenAI's", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="openai" runtimeProvider="codex" />);
    const stack = getByLabelText("OpenAI via Codex");
    expect(stack.querySelector(".provider-family-codex img.provider-mark")).toBeTruthy();
    expect(stack.querySelector(".provider-family-openai .provider-mark")).toBeTruthy();
  });
});
