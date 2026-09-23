// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UiModel } from "../../shared/contracts";
import type { PaletteItem, PaletteSearchContext, RuntimeModels, WorkbenchActions } from "../extension-system";
import { PreferencesStore } from "../preferences";
import { modelMenu, newThreadRuntimeMenu, themeMenu } from "./palette-menus";

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
  const search: PaletteSearchContext = { actions, index: { projects: [], threads: [] }, signal: new AbortController().signal };
  return { actions, search };
}

const ids = (items: readonly PaletteItem[]) => items.map((item) => item.id);

describe("the model level", () => {
  it("lists the thread's runtime first, favourites first within a runtime, and leaves hidden models out", async () => {
    const preferences = new PreferencesStore();
    preferences.toggleFavouriteModel("codex:openai/gpt-5.6-sol");
    preferences.toggleHiddenModel("pi", "anthropic/claude-haiku-4-5");
    const { search } = context({ sessionId: "t1", backendKind: "codex", model: { provider: "openai", id: "gpt-5.6-luna" }, draftPending: false });
    const items = await modelMenu(preferences).items("", search);
    expect(ids(items)).toEqual(["codex:openai/gpt-5.6-sol", "codex:openai/gpt-5.6-luna", "openai/gpt-5.6-luna"]);
    expect(items.find((item) => item.current)?.id).toBe("codex:openai/gpt-5.6-luna");
    expect(items[1]!.detail).toBe("Plan");
    // The runtime is an icon named for assistive technology, and a word the search finds.
    expect(items[1]!.keywords).toContain("Codex");
    const { container } = render(<>{items[1]!.icon}</>);
    expect(container.querySelector("[role=img]")?.getAttribute("aria-label")).toBe("OpenAI via Codex");
  });

  it("sets a model of the thread's runtime and starts a thread for another runtime's", async () => {
    const { actions, search } = context({ sessionId: "t1", backendKind: "pi", draftPending: false });
    const items = await modelMenu(new PreferencesStore()).items("", search);
    await items.find((item) => item.id === "openai/gpt-5.6-luna")!.run!(actions);
    expect(actions.setModel).toHaveBeenCalledWith("openai", "gpt-5.6-luna");
    await items.find((item) => item.id === "codex:openai/gpt-5.6-sol")!.run!(actions);
    expect(actions.startThreadOn).toHaveBeenCalledWith("codex", sol);
  });
});

describe("the new-thread runtime level", () => {
  it("draws each runtime as its icon, says whether a thread can start there, and marks the draft's", async () => {
    const { actions, search } = context({ backendKind: "codex", draftPending: false });
    const items = await newThreadRuntimeMenu().items("", search);
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

describe("the theme level", () => {
  it("marks the theme in use and applies the one chosen", async () => {
    const preferences = new PreferencesStore();
    preferences.setTheme("dark");
    const apply = vi.fn();
    const { actions, search } = context(undefined);
    const items = await themeMenu(preferences, apply).items("", search);
    expect(items.map((item) => [item.label, item.current])).toEqual([["System", false], ["Dark", true], ["Light", false]]);
    await items[2]!.run!(actions);
    expect(apply).toHaveBeenCalledWith(actions, "light");
  });
});
