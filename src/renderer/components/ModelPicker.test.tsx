// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiModel } from "../../shared/contracts";
import { ModelPicker } from "./ModelPicker";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";

const models: UiModel[] = [
  { provider: "anthropic", id: "claude-fable-5", name: "Claude Fable 5", login: "subscription" },
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
];

function renderPicker(options: { runtime?: string; preferences?: PreferencesStore; onSelect?: (model: UiModel) => void } = {}) {
  const onSelect = options.onSelect ?? vi.fn();
  render(<TestProviders preferences={options.preferences}>
    <ModelPicker models={models} onSelect={onSelect} onClose={() => {}} runtime={options.runtime} />
  </TestProviders>);
  return onSelect;
}

afterEach(cleanup);

describe("ModelPicker", () => {
  it("shows one icon per provider on the rail, the runtime's logo behind it unless the runtime is Pi", () => {
    renderPicker({ runtime: "claude-code" });
    const rail = screen.getByRole("navigation", { name: "Providers" });
    expect(rail.querySelectorAll("button")).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Claude (4)" }).querySelector(".provider-icon-runtime")).toBeTruthy();
    expect(screen.getByRole("button", { name: "OpenAI (1)" }).querySelector(".provider-icon-runtime")).toBeTruthy();
    cleanup();
    renderPicker({ runtime: "pi" });
    expect(document.querySelector(".provider-icon-runtime")).toBeNull();
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

  it("tags models behind a subscription login and explains the tag once per list", () => {
    renderPicker();
    expect(screen.getAllByText("subscription login")).toHaveLength(1);
    expect(screen.getByText(/asks once before the first use/u)).toBeTruthy();
  });
});
