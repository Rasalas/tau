// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, cleanup, render } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ExtensionRegistry, type DesktopExtensionContext } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { declareRuntimeMarks } from "../runtime-marks";
import { WorkbenchShellContext } from "../workbench-context";
import { BUNDLED_RUNTIME_MARKS } from "../test-support/runtime-marks";
import { ProviderIconStack, monogram, providerHasMark, providerLabel } from "./ProviderIconStack";

afterEach(cleanup);
beforeAll(() => declareRuntimeMarks(BUNDLED_RUNTIME_MARKS));
afterAll(() => declareRuntimeMarks([]));

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
  ])("badges %s's mark with Pi's", (modelProvider, label, family) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={modelProvider} runtimeProvider="pi" />);
    const stack = getByLabelText(`Pi via ${label}`);
    expect(stack.querySelector(`.provider-icon-model.provider-family-${family} .provider-mark`)).toBeTruthy();
    expect(stack.querySelector(".provider-icon-runtime.provider-family-pi")).toBeTruthy();
    expect(stack.classList).toContain("stacked");
  });

  it.each([
    // runtime, provider, plan, drawn families (the access mark, then the runtime's behind it), tooltip
    ["codex", "openai", false, ["codex"], "Codex (OpenAI)"],
    ["claude-code", "anthropic", false, ["claude-code"], "Claude Code (Anthropic)"],
    ["grok", "xai", false, ["grok"], "Grok (xAI)"],
    ["antigravity", "google", false, ["antigravity"], "Antigravity (Google Gemini)"],
    ["cursor", "cursor", false, ["cursor"], "Cursor"],
    ["antigravity", "anthropic", false, ["anthropic", "antigravity"], "Antigravity via Anthropic"],
    ["opencode", "openai", false, ["openai", "opencode"], "OpenCode via OpenAI"],
    ["pi", "openai", false, ["openai", "pi"], "Pi via OpenAI"],
    ["pi", "openrouter", false, ["openrouter", "pi"], "Pi via OpenRouter"],
    ["pi", "openai-codex", false, ["codex", "pi"], "Pi via ChatGPT plan"],
    ["pi", "anthropic", true, ["claude-code", "pi"], "Pi via Claude plan"],
    ["pi", "xai", true, ["grok", "pi"], "Pi via Grok plan"],
    ["cursor", "anthropic", true, ["anthropic", "cursor"], "Cursor via Anthropic"],
  ] as const)("draws %s with %s (plan: %s)", (runtime, provider, plan, families, tooltip) => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider={provider} runtimeProvider={runtime} plan={plan} />);
    const stack = getByLabelText(tooltip);
    expect(stack.getAttribute("title")).toBe(tooltip);
    expect([...stack.children].map((icon) => [...icon.classList].find((name) => name.startsWith("provider-family-"))?.slice("provider-family-".length))).toEqual(families);
    expect(stack.classList).toContain(families.length > 1 ? "stacked" : "single");
  });

  it("follows what a runtime declares once the host names it", () => {
    declareRuntimeMarks([]);
    const { getByLabelText } = render(<ProviderIconStack modelProvider="openai" runtimeProvider="codex" />);
    expect(getByLabelText("Codex via OpenAI").classList).toContain("stacked");
    act(() => declareRuntimeMarks(BUNDLED_RUNTIME_MARKS));
    expect(getByLabelText("Codex (OpenAI)").classList).toContain("single");
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

  it("badges a provider a runtime does not own with that runtime", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="google" runtimeProvider="opencode" />);
    const stack = getByLabelText("OpenCode via Google Gemini");
    expect(stack.querySelectorAll(".provider-mark")).toHaveLength(2);
    expect(stack.classList).toContain("stacked");
    expect(stack.firstElementChild?.classList).toContain("provider-icon-model");
    expect(stack.lastElementChild?.classList).toContain("provider-icon-runtime");
  });

  it("leaves the runtime's mark out where the runtime is named around it, and names the model and instance", () => {
    const { getByLabelText } = render(<ProviderIconStack modelProvider="openai-codex" runtimeProvider="pi" runtimeMark={false} modelName="GPT-5.6 Luna" />);
    const stack = getByLabelText("GPT-5.6 Luna · Pi via ChatGPT plan");
    expect(stack.classList).toContain("single");
    expect(stack.querySelector(".provider-family-pi")).toBeNull();
    cleanup();
    expect(render(<ProviderIconStack modelProvider="openai" runtimeProvider="codex@work" runtimeName="Codex · work" modelName="GPT-5.6 Luna" />).getByLabelText("GPT-5.6 Luna · Codex · work (OpenAI)")).toBeTruthy();
  });
});

describe("two marks on screen", () => {
  it("stand side by side, the runtime's quieter, with no overlap or hover fan (design 1a, K96)", () => {
    const css = readFileSync(join(import.meta.dirname, "..", "styles.css"), "utf8").replace(/\/\*[\s\S]*?\*\//gu, "");
    const rules = [...css.matchAll(/([^{}]*\.provider-icon-stack\.stacked[^{}]*)\{([^}]*)\}/gu)].map((match) => `${match[1]!.trim()} {${match[2]}}`);
    expect(rules.join("\n")).not.toMatch(/translate|position: absolute|:hover|mask-/u);
    expect(rules).toContain(".provider-icon-stack.stacked { width: auto; gap: 6px; }");
    expect(rules.find((rule) => rule.includes("> .provider-icon-runtime"))).toMatch(/opacity: \.7/u);
    expect(rules.find((rule) => rule.startsWith(":is(.runtime-chip"))).toMatch(/gap: 3px/u);
  });
});

describe("provider pictures a kit publishes (setProviderIcons)", () => {
  const logo = "data:image/png;base64,iVBORw0KGgo=";
  function setup() {
    const registry = new ExtensionRegistry(undefined, { preferences: new PreferencesStore() });
    const contexts: DesktopExtensionContext[] = [];
    for (const id of ["first", "second"]) registry.activate({ id, name: id, activate(context) { contexts.push(context); } });
    const draw = (node: React.ReactNode) => render(<WorkbenchShellContext.Provider value={{ registry }}>{node}</WorkbenchShellContext.Provider>);
    return { registry, first: contexts[0]!, second: contexts[1]!, draw };
  }

  it("keys pictures the way marks are keyed, keeps pictures only, lets the first extension win", () => {
    const { registry, first, second } = setup();
    first.setProviderIcons({ "KI_Connect": logo, other: "https://tracker.example/x.png" });
    second.setProviderIcons({ "ki-connect": "data:image/png;base64,Zm9v" });
    expect(registry.providerIcon("ki.connect")).toBe(logo);
    expect(registry.providerIcon("other")).toBeUndefined();
    registry.deactivate("first");
    expect(registry.providerIcon("ki-connect")).toBe("data:image/png;base64,Zm9v");
  });

  it("draws a picture instead of the initial, never instead of a mark Tau ships, and follows a change", () => {
    const { first, draw } = setup();
    const { container } = draw(<><ProviderIconStack modelProvider="radius" runtimeProvider="pi" /><ProviderIconStack modelProvider="openai" /></>);
    const radius = () => container.querySelector(".provider-family-radius");
    expect(radius()?.classList).toContain("provider-icon-fallback");
    act(() => first.setProviderIcons({ radius: logo, openai: logo }));
    expect(radius()?.querySelector("img.provider-mark-picture")?.getAttribute("src")).toBe(logo);
    expect(radius()?.classList).not.toContain("provider-icon-fallback");
    expect(container.querySelector(".provider-family-openai img.provider-mark-picture")).toBeNull();
    act(() => first.setProviderIcons(undefined));
    expect(radius()?.textContent).toBe("R");
  });

  it("tells which providers have a mark of Tau's own", () => {
    expect(providerHasMark("anthropic")).toBe(true);
    expect(providerHasMark("deepseek")).toBe(true);
    expect(providerHasMark("ki:connect")).toBe(false);
  });
});
