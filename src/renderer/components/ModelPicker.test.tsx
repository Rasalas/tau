// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiModel } from "../../shared/contracts";
import { ModelPicker } from "./ModelPicker";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";

const models: UiModel[] = [
  { provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1", login: "subscription" },
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
];

function renderPicker(options: {
  runtime?: string;
  preferences?: PreferencesStore;
  onSelect?: (model: UiModel) => void;
  catalogRuntime?: string;
  runtimeBackends?: { kind: string; label: string }[];
  onSelectRuntime?: (kind: string) => void;
  onNewThreadOnRuntime?: (kind: string) => void;
} = {}) {
  const onSelect = options.onSelect ?? vi.fn();
  render(<TestProviders preferences={options.preferences}>
    <ModelPicker
      models={models}
      onSelect={onSelect}
      onClose={() => {}}
      runtime={options.runtime}
      catalogRuntime={options.catalogRuntime}
      runtimeBackends={options.runtimeBackends}
      onSelectRuntime={options.onSelectRuntime}
      onNewThreadOnRuntime={options.onNewThreadOnRuntime}
    />
  </TestProviders>);
  return onSelect;
}

const backends = [
  { kind: "pi", label: "Pi" },
  { kind: "claude-code", label: "Claude Code" },
  { kind: "antigravity", label: "Antigravity" },
];

afterEach(cleanup);

describe("ModelPicker", () => {
  it("offers another runtime to a new thread from its rail tab", () => {
    const onSelectRuntime = vi.fn();
    const onSelect = renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime });
    fireEvent.click(screen.getByRole("button", { name: "Claude Code" }));
    const pane = screen.getByRole("region", { name: "Claude Code" });
    expect(pane.textContent).toMatch(/runs the thread instead of Pi/u);
    fireEvent.click(screen.getByRole("button", { name: "Start this thread on Claude Code" }));
    expect(onSelectRuntime).toHaveBeenCalledWith("claude-code");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("opens a draft bound for another runtime on that runtime's tab, with Pi's models a click away", () => {
    renderPicker({ runtime: "claude-code", catalogRuntime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn() });
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toMatch(/starts on Claude Code with its default model/u);
    expect(screen.queryByRole("button", { name: /^Start this thread/u })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Anthropic (4)" }));
    expect(screen.getByText("Claude Opus 5")).toBeTruthy();
  });

  it("explains in a Pi thread that another runtime starts a new thread", () => {
    const onNewThreadOnRuntime = vi.fn();
    renderPicker({ runtime: "pi", runtimeBackends: backends, onNewThreadOnRuntime });
    const tab = screen.getByRole("button", { name: "Antigravity" });
    expect(tab.getAttribute("title")).toBe("Antigravity · starts a new thread");
    fireEvent.click(tab);
    expect(screen.getByRole("region", { name: "Antigravity" }).textContent).toMatch(/This thread runs on Pi, and a thread keeps the runtime it started on/u);
    fireEvent.click(screen.getByRole("button", { name: "New thread on Antigravity" }));
    expect(onNewThreadOnRuntime).toHaveBeenCalledWith("antigravity");
  });

  it("shows provider marks without Pi's, and a non-Pi runtime's mark beside its models", () => {
    renderPicker({ runtime: "pi", runtimeBackends: backends });
    const rail = screen.getByRole("navigation", { name: "Providers" });
    expect(rail.querySelectorAll("button")).toHaveLength(4);
    expect(document.querySelector(".provider-family-pi")).toBeNull();
    expect(screen.getByRole("button", { name: "Claude Code" }).querySelector(".provider-family-claude-code")).toBeTruthy();
    cleanup();
    renderPicker({ runtime: "claude-code", runtimeBackends: backends });
    expect(screen.getByRole("button", { name: "Claude Code (5)" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Pi" }).getAttribute("title")).toBe("Pi · starts a new thread");
    expect(document.querySelector(".model-sub .provider-family-claude-code")).toBeTruthy();
  });

  it("folds a provider's legacy models behind one row and badges the newest", () => {
    renderPicker();
    expect(screen.getByText("NEW")).toBeTruthy();
    expect(screen.queryByText("Claude Opus 4.1")).toBeNull();
    const fold = screen.getByRole("button", { name: /Legacy models/u });
    expect(fold.textContent).toContain("2 models");
    fireEvent.click(fold);
    expect(screen.getByText("Claude Opus 4.1")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Legacy models/u }));
    expect(screen.queryByText("Claude Opus 4.1")).toBeNull();
  });

  it("lists legacy models flat while searching, tagged", () => {
    renderPicker();
    fireEvent.change(screen.getByRole("textbox", { name: "Search models" }), { target: { value: "sonnet" } });
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("legacy")).toBeTruthy();
    expect(screen.queryByText("Legacy models")).toBeNull();
  });

  it("reaches the n-th favourite with ⌘n and shows the chord on its row", () => {
    const preferences = new PreferencesStore();
    preferences.toggleFavouriteModel("openai-codex/gpt-5.6-sol");
    preferences.toggleFavouriteModel("anthropic/claude-opus-5");
    const onSelect = renderPicker({ preferences });
    expect(screen.getByText("⌘2")).toBeTruthy();
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search models" }), { key: "2", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-opus-5" }));
  });

  it("tags models behind a subscription login, and leaves any warning about it to an extension", () => {
    renderPicker();
    expect(screen.getAllByText("subscription login")).toHaveLength(1);
    expect(document.querySelector(".model-picker-note")).toBeNull();
  });

  it("switches providers via ArrowLeft and ArrowRight", () => {
    renderPicker();
    const searchInput = screen.getByRole("textbox", { name: "Search models" });

    // Initially on anthropic:
    expect(screen.getByText("Claude Fable 5.1")).toBeTruthy();
    expect(screen.queryByText("GPT-5.6 Sol")).toBeNull();

    // ArrowRight switches to openai-codex
    fireEvent.keyDown(searchInput, { key: "ArrowRight" });
    expect(screen.getByText("GPT-5.6 Sol")).toBeTruthy();
    expect(screen.queryByText("Claude Fable 5.1")).toBeNull();

    // ArrowLeft switches back to anthropic
    fireEvent.keyDown(searchInput, { key: "ArrowLeft" });
    expect(screen.getByText("Claude Fable 5.1")).toBeTruthy();
  });
});

