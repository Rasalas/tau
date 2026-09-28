// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiModel } from "../../shared/contracts";
import type { PaletteItem, RuntimeModels, WorkbenchActions } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { modelItems, runtimeItems, themeItems } from "./palette-menus";

const luna: UiModel = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" };
const sol: UiModel = { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" };
const haiku: UiModel = { provider: "anthropic", id: "claude-haiku-4-5", name: "Haiku 4.5", billing: "api-key" };

const runtimes: RuntimeModels[] = [
  { backend: { kind: "pi", label: "Pi" }, catalog: { kind: "pi", models: [haiku, luna], thinkingLevels: {} } },
  { backend: { kind: "codex", label: "Codex" }, catalog: { kind: "codex", models: [luna, sol], model: luna, thinkingLevels: {} } },
  { backend: { kind: "antigravity", label: "Antigravity" }, catalog: { kind: "antigravity", models: [], thinkingLevels: {}, status: "not-installed" } },
];

function context(thread: ReturnType<WorkbenchActions["activeThread"]>) {
  const actions = {
    activeThread: () => thread,
    runtimeModels: vi.fn(async () => runtimes),
    setModel: vi.fn(async () => true),
    startThreadOn: vi.fn(),
    notify: vi.fn(),
  } as unknown as WorkbenchActions;
  return { actions };
}

const ids = (items: readonly PaletteItem[]) => items.map((item) => item.id);

describe("the model rows", () => {
  it("lists the thread's runtime first, favourites first within a runtime, and leaves hidden models out", async () => {
    const preferences = new PreferencesStore();
    preferences.toggleFavouriteModel("codex:openai/gpt-5.6-sol");
    preferences.toggleHiddenModel("pi", "anthropic/claude-haiku-4-5");
    const { actions } = context({ sessionId: "t1", backendKind: "codex", model: { provider: "openai", id: "gpt-5.6-luna" }, draftPending: false });
    const items = await modelItems(preferences, actions);
    expect(ids(items)).toEqual(["codex:openai/gpt-5.6-sol", "codex:openai/gpt-5.6-luna", "openai/gpt-5.6-luna"]);
    expect(items.find((item) => item.current)?.id).toBe("codex:openai/gpt-5.6-luna");
    expect(items[1]!.detail).toBe("Plan");
    // The runtime is an icon named for assistive technology, and a word the search finds.
    expect(items[1]!.keywords).toContain("Codex");
    const { container } = render(<>{items[1]!.icon}</>);
    expect(container.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("Codex (OpenAI)");
  });

  it("sets a model of the thread's runtime and starts a thread for another runtime's", async () => {
    const { actions } = context({ sessionId: "t1", backendKind: "pi", draftPending: false });
    const items = await modelItems(new PreferencesStore(), actions);
    await items.find((item) => item.id === "openai/gpt-5.6-luna")!.run!(actions);
    expect(actions.setModel).toHaveBeenCalledWith("openai", "gpt-5.6-luna");
    await items.find((item) => item.id === "codex:openai/gpt-5.6-sol")!.run!(actions);
    expect(actions.startThreadOn).toHaveBeenCalledWith("codex", sol);
  });
});

describe("the new-thread runtime rows", () => {
  it("draws each runtime as its icon, says whether a thread can start there, and marks the draft's", async () => {
    const { actions } = context({ backendKind: "codex", draftPending: false });
    const items = await runtimeItems(actions);
    expect(items.map((item) => [item.id, item.label, item.detail ?? "", item.current])).toEqual([
      ["pi", "Ready", "2 models", false],
      ["codex", "Ready", "2 models · starts on GPT-5.6 Luna", true],
      ["antigravity", "Not installed", "", false],
    ]);
    expect(items.every((item) => !item.label.includes(item.keywords![0]!))).toBe(true);
    items[2]!.run!(actions);
    expect(actions.startThreadOn).toHaveBeenCalledWith("antigravity");
  });
});

describe("the theme rows", () => {
  it("marks the theme in use and applies the one chosen", async () => {
    const preferences = new PreferencesStore();
    preferences.setTheme("dark");
    const apply = vi.fn();
    const { actions } = context(undefined);
    const items = themeItems(preferences, apply);
    expect(items.map((item) => [item.label, item.current])).toEqual([["System", false], ["Dark", true], ["Light", false]]);
    await items[2]!.run!(actions);
    expect(apply).toHaveBeenCalledWith(actions, "light");
  });
});
