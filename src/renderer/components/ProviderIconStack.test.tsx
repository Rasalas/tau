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
  ])("puts Pi's mark beside %s's", (modelProvider, label, family) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={modelProvider} runtimeProvider="pi" />);
    const stack = getByLabelText(`${label} via Pi`);
    expect(stack.querySelector(`.provider-icon-model.provider-family-${family} .provider-mark`)).toBeTruthy();
    expect(stack.querySelector(".provider-icon-runtime.provider-family-pi")).toBeTruthy();
    expect(stack.classList).toContain("stacked");
  });

  it.each([
    // runtime, provider, plan, drawn families (runtime first), tooltip
    ["codex", "openai", false, ["codex"], "Codex (OpenAI)"],
    ["claude-code", "anthropic", false, ["claude-code"], "Claude Code (Anthropic)"],
    ["grok", "xai", false, ["grok"], "Grok (xAI)"],
    ["antigravity", "google", false, ["antigravity"], "Antigravity (Google Gemini)"],
    ["cursor", "cursor", false, ["cursor"], "Cursor"],
    ["antigravity", "anthropic", false, ["antigravity", "anthropic"], "Anthropic via Antigravity"],
    ["opencode", "openai", false, ["opencode", "openai"], "OpenAI via OpenCode"],
    ["pi", "openai", false, ["pi", "openai"], "OpenAI via Pi"],
    ["pi", "openrouter", false, ["pi", "openrouter"], "OpenRouter via Pi"],
    ["pi", "openai-codex", false, ["pi", "codex"], "ChatGPT plan via Pi"],
    ["pi", "anthropic", true, ["pi", "claude-code"], "Claude plan via Pi"],
    ["pi", "xai", true, ["pi", "grok"], "Grok plan via Pi"],
  ] as const)("draws %s with %s (plan: %s)", (runtime, provider, plan, families, tooltip) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={provider} runtimeProvider={runtime} plan={plan} />);
    const stack = getByLabelText(tooltip);
    expect(stack.getAttribute("title")).toBe(tooltip);
    expect([...stack.children].map((icon) => [...icon.classList].find((name) => name.startsWith("provider-family-"))?.slice("provider-family-".length))).toEqual(families);
    expect(stack.classList).toContain(families.length > 1 ? "stacked" : "single");
  });

  it("draws a plan by its mark where the list is Pi's", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="openai-codex" />);
    expect(getByLabelText("ChatGPT plan").querySelector(".provider-family-codex img.provider-mark")).toBeTruthy();
    expect(providerLabel("openai-codex")).toBe("ChatGPT plan");
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
    const stack = getByLabelText("Codex (OpenAI)");
    expect(stack.querySelector(".provider-family-codex img.provider-mark")).toBeTruthy();
    expect(stack.querySelector(".provider-family-openai")).toBeNull();
    cleanup();
    expect(render(<ProviderIconStack runtimeProvider="claude-code@second" />).getByLabelText("Claude Code")).toBeTruthy();
  });

  it("pairs a runtime with a provider it does not own", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="google" runtimeProvider="opencode" />);
    const stack = getByLabelText("Google Gemini via OpenCode");
    expect(stack.querySelectorAll(".provider-mark")).toHaveLength(2);
    expect(stack.classList).toContain("stacked");
    expect(stack.firstElementChild?.classList).toContain("provider-icon-runtime");
    expect(stack.lastElementChild?.classList).toContain("provider-icon-model");
  });
});
