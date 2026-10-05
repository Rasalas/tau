// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { UiModel, UiRuntimeBackend } from "../../shared/contracts";
import { ModelPicker, type RuntimeAction } from "./ModelPicker";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";
import { declareRuntimeMarks } from "../runtime-marks";
import { BUNDLED_RUNTIME_MARKS } from "../test-support/runtime-marks";
import { setHostClient } from "../host-client-context";
import type { HostClient } from "../../workbench/host-client";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";

beforeAll(() => declareRuntimeMarks(BUNDLED_RUNTIME_MARKS));
afterAll(() => declareRuntimeMarks([]));
afterEach(cleanup);

const models: UiModel[] = [
  { provider: "anthropic", id: "claude-fable-5-1", name: "Claude Fable 5.1", login: "subscription" },
  { provider: "anthropic", id: "claude-opus-5", name: "Claude Opus 5" },
  { provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
  { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
  { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", billing: "subscription" },
  { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", billing: "api-key", price: { input: 5, output: 30 } },
];
const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" as const, price: { input: 0.2, output: 1.2 }, contextWindow: 400_000 };
const solCodex = { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6-Sol", billing: "subscription" as const, contextWindow: 272_000 };
const backends: UiRuntimeBackend[] = [
  { kind: "pi", label: "Pi" },
  { kind: "claude-code", label: "Claude Code", homeProviders: ["anthropic"] },
  { kind: "antigravity", label: "Antigravity" },
  { kind: "codex", label: "Codex", homeProviders: ["openai"] },
];
const cached = (entries: Array<[string, RuntimeCatalogEntry]>) => new Map(entries);
const codexReady = (list: UiModel[] = [luna, solCodex]): [string, RuntimeCatalogEntry] => ["codex", { status: "ready", catalog: { kind: "codex", models: list, thinkingLevels: {} } }];
const notInstalled: [string, RuntimeCatalogEntry] = ["claude-code", { status: "unavailable", reason: "not-installed" }];

function renderPicker(options: {
  runtime?: string;
  preferences?: PreferencesStore;
  onSelect?: (model: UiModel, runtime?: string) => void;
  catalogRuntime?: string;
  catalogs?: ReadonlyMap<string, RuntimeCatalogEntry>;
  runtimeBackends?: UiRuntimeBackend[];
  onSelectRuntime?: (kind: string) => void;
  onNewThreadOnRuntime?: (kind: string, model?: UiModel) => void;
  runtimeActions?: RuntimeAction[];
  activeKey?: string;
  list?: UiModel[];
  onClose?: () => void;
  onOpenSettings?: (kind: string, part: "runtime" | "models") => void;
  onOpenThinking?: () => void;
} = {}) {
  const onSelect = options.onSelect ?? vi.fn();
  render(<TestProviders preferences={options.preferences}>
    <ModelPicker
      models={options.list ?? models}
      activeKey={options.activeKey}
      onSelect={onSelect}
      onClose={options.onClose ?? (() => {})}
      anchor={{ current: null }}
      onOpenSettings={options.onOpenSettings}
      runtime={options.runtime}
      catalogRuntime={options.catalogRuntime}
      runtimeBackends={options.runtimeBackends}
      catalogs={options.catalogs}
      onSelectRuntime={options.onSelectRuntime}
      onNewThreadOnRuntime={options.onNewThreadOnRuntime}
      runtimeActions={options.runtimeActions}
      thinkingSummary="High · 1M"
      onOpenThinking={options.onOpenThinking}
    />
  </TestProviders>);
  return onSelect;
}

const search = () => screen.getByRole("combobox", { name: "Search models" });
const rail = () => within(screen.getByRole("navigation", { name: "Providers" })).getAllByRole("button").map((button) => button.getAttribute("aria-label"));
const railButton = (label: string) => within(screen.getByRole("navigation", { name: "Providers" })).getByRole("button", { name: new RegExp(`^${label}`, "u") });
const optionNames = () => screen.queryAllByRole("option").map((option) => option.getAttribute("aria-label"));
const ways = () => [...screen.getByRole("radiogroup", { name: /^Runs with/u }).querySelectorAll("button")].map((button) => `${button.getAttribute("aria-label")}${button.getAttribute("aria-checked") === "true" ? " ✓" : ""}${(button as HTMLButtonElement).disabled ? " (off)" : ""}`);
const note = () => document.querySelector(".model-ways-note")?.textContent ?? "";

describe("ModelPicker (K142 B: model first)", () => {
  it("lists who made the models on the rail, each model once, and the runtimes that list none after them", () => {
    renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady(), notInstalled]) });
    expect(rail()).toEqual(["Favourites", "Recent", "OpenAI", "Anthropic", "Claude Code, not installed", "Antigravity, models listed once a thread runs"]);
    fireEvent.click(railButton("OpenAI"));
    // GPT-5.6 Sol is one row though Pi reaches it two ways and Codex a third.
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Pi, Plan", "GPT-5.6 Luna, Codex, Plan"]);
    const sol = screen.getAllByRole("option")[0]!;
    expect(within(sol).getAllByRole("img").map((mark) => mark.getAttribute("aria-label"))).toEqual(["Pi", "Codex"]);
    expect(sol.textContent).toMatch(/272k · API \$5\/\$30/u);
  });

  it("offers every way to run the highlighted model under the list; Tab and the arrows pick one, Enter takes both", () => {
    const onSelect = renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    fireEvent.click(railButton("OpenAI"));
    expect(ways()).toEqual(["Pi, Plan ✓", "Pi, API key", "Codex, Plan"]);
    expect(note()).toMatch(/^Pi via ChatGPT plan · in the plan/u);
    const input = search();
    input.focus();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pi, Plan");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    fireEvent.keyDown(document.activeElement!, { key: "ArrowRight" });
    expect(ways()).toEqual(["Pi, Plan", "Pi, API key", "Codex, Plan ✓"]);
    expect(note()).toMatch(/^Codex \(OpenAI\) · 272k context/u);
    fireEvent.keyDown(document.activeElement!, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(solCodex, "codex");
  });

  it("keeps a running thread on its runtime: the thread's runtime stands greyed first, and a way elsewhere continues in a new thread", () => {
    const onSelect = renderPicker({
      runtime: "pi", runtimeBackends: backends, catalogs: cached([codexReady()]),
      runtimeActions: [{ id: "handoff.continue-in", label: "Continue in", run: vi.fn() }],
    });
    fireEvent.click(railButton("OpenAI"));
    fireEvent.keyDown(search(), { key: "ArrowDown" });
    expect(ways()).toEqual(["Pi, can't run it (off)", "Codex, Plan ✓"]);
    expect(note()).toBe("This thread runs with Pi. ↵ continues in a new thread with Codex, carrying a summary.");
    fireEvent.keyDown(search(), { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(luna, "codex");
  });

  it("offers what makes a runtime of the model's maker ready: Install, Sign in (from E)", () => {
    const onOpenSettings = vi.fn();
    renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady(), notInstalled]), onOpenSettings });
    fireEvent.click(railButton("Anthropic"));
    expect(ways()).toEqual(["Pi, Plan ✓", "Install Claude Code"]);
    fireEvent.click(screen.getByRole("button", { name: "Install Claude Code" }));
    expect(onOpenSettings).toHaveBeenCalledWith("claude-code", "runtime");
  });

  it("searches every provider and runtime at once, one row per model", () => {
    renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    fireEvent.change(search(), { target: { value: "sol" } });
    expect(screen.getByText("Every provider · 1 match")).toBeTruthy();
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Pi, Plan"]);
    expect(ways()).toEqual(["Pi, Plan ✓", "Pi, API key", "Codex, Plan"]);
    // A runtime's name narrows the ways to it (Pi's ChatGPT plan goes through "openai-codex").
    fireEvent.change(search(), { target: { value: "sol codex" } });
    expect(ways()).toEqual(["Pi, Plan ✓", "Codex, Plan"]);
  });

  it("pins a model with its way: ⌘n reaches it, Favourites lists it with that way, the row's star is the way's", () => {
    const preferences = new PreferencesStore();
    preferences.toggleFavouriteModel("codex:openai/gpt-5.6-sol");
    const onSelect = renderPicker({ preferences, runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    fireEvent.click(railButton("OpenAI"));
    // The pinned way comes first for its row.
    expect(ways()).toEqual(["Pi, Plan", "Pi, API key", "Codex, Plan ✓"]);
    expect(screen.getByText("⌘1")).toBeTruthy();
    fireEvent.click(railButton("Favourites"));
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Codex, Plan"]);
    fireEvent.keyDown(search(), { key: "1", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(solCodex, "codex");
    expect(preferences.getSnapshot().recentModels).toEqual(["codex:openai/gpt-5.6-sol"]);
    fireEvent.click(railButton("Recent"));
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Codex, Plan"]);
  });

  it("lists a recent model with the thinking level it was last used with, and hands it back on a pick", () => {
    const preferences = new PreferencesStore();
    preferences.noteModelUsed("openai/gpt-5.6-sol");
    preferences.noteModelLevel("openai/gpt-5.6-sol", "high");
    // A model that is no recent one keeps no level.
    preferences.noteModelLevel("openai/gpt-5.6-luna", "low");
    expect(preferences.getSnapshot().recentLevels).toEqual({ "openai/gpt-5.6-sol": "high" });
    const onSelect = renderPicker({ preferences, runtime: "pi", onSelect: vi.fn() }) as ReturnType<typeof vi.fn>;
    fireEvent.click(railButton("Recent"));
    expect(screen.getByRole("option", { name: /GPT-5.6 Sol/u }).textContent).toContain("High");
    fireEvent.click(screen.getByRole("option", { name: /GPT-5.6 Sol/u }));
    expect(onSelect).toHaveBeenCalledWith(models[5], undefined, "high");
    // Another rail entry hands over no level.
    fireEvent.click(railButton("OpenAI"));
    onSelect.mockClear();
    fireEvent.click(screen.getByRole("option", { name: /GPT-5.6 Sol/u }));
    expect(onSelect.mock.calls[0]).toHaveLength(1);
  });

  it("adds a badge's line after the facts under Runs with, for the way highlighted", () => {
    const badge = { id: "test.left", applies: () => false, label: "Plan", WayLine: ({ runtime }: { runtime: string }) => <> · 65% left on {runtime}</> };
    render(<TestProviders><ModelPicker models={models} activeKey="anthropic/claude-opus-5" onSelect={vi.fn()} onClose={() => {}} anchor={{ current: null }} badges={[badge]} /></TestProviders>);
    expect(document.querySelector(".model-ways-note")!.textContent).toMatch(/ · 65% left on pi$/u);
    expect(screen.queryByText("Plan", { selector: ".model-badge" })).toBeNull();
  });

  it("folds a maker's legacy models behind one row and badges the newest", () => {
    renderPicker();
    fireEvent.click(railButton("Anthropic"));
    expect(screen.getByText("NEW")).toBeTruthy();
    expect(screen.queryByText("Claude Opus 4.1")).toBeNull();
    const fold = screen.getByRole("option", { name: /Legacy models/u });
    expect(fold.textContent).toBe("Legacy models 2");
    fireEvent.click(fold);
    expect(screen.getByText("Claude Opus 4.1")).toBeTruthy();
  });

  it("hides a model with every way to run it", () => {
    const preferences = new PreferencesStore();
    renderPicker({ preferences, runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    fireEvent.click(railButton("OpenAI"));
    fireEvent.click(screen.getByRole("button", { name: "Hide GPT-5.6 Sol from the picker" }));
    expect(preferences.getSnapshot().modelPreferences.pi?.hidden).toEqual(["openai-codex/gpt-5.6-sol", "openai/gpt-5.6-sol"]);
    expect(preferences.getSnapshot().modelPreferences.codex?.hidden).toEqual(["openai/gpt-5.6-sol"]);
    expect(optionNames()).toEqual(["GPT-5.6 Luna, Codex, Plan"]);
  });

  it("opens a draft bound for a runtime that lists nothing on that runtime, and moves a draft to one", () => {
    const onSelectRuntime = vi.fn();
    renderPicker({ runtime: "antigravity", catalogRuntime: "pi", runtimeBackends: backends, onSelectRuntime });
    expect(screen.getByRole("region", { name: "Antigravity" }).textContent).toMatch(/starts on Antigravity with its default model/u);
    fireEvent.click(railButton("Claude Code"));
    expect(onSelectRuntime).toHaveBeenCalledWith("claude-code");
  });

  it("offers a thread that exists a new thread on a runtime that lists nothing, and what kits do with one", () => {
    const onNewThreadOnRuntime = vi.fn();
    const run = vi.fn();
    renderPicker({ runtime: "pi", runtimeBackends: backends, onNewThreadOnRuntime, runtimeActions: [{ id: "handoff.continue-in", label: "Continue in", run }] });
    fireEvent.click(railButton("Antigravity"));
    expect(screen.getByRole("region", { name: "Antigravity" }).textContent).toMatch(/a thread keeps the runtime it started on/u);
    fireEvent.click(screen.getByRole("button", { name: "Continue in Antigravity" }));
    expect(run).toHaveBeenCalledWith("antigravity");
    fireEvent.click(screen.getByRole("button", { name: "New thread on Antigravity" }));
    expect(onNewThreadOnRuntime).toHaveBeenCalledWith("antigravity");
  });

  it("hands Shift-clicks to the model selection an extension registered, and a plain pick resets it", () => {
    let chosen: string[] = [];
    const listeners = new Set<() => void>();
    const selection = {
      id: "test.selection",
      selected: () => chosen,
      subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
      toggle: vi.fn((model: UiModel, current: UiModel | undefined) => {
        chosen = [...(chosen.length === 0 && current ? [`${current.provider}/${current.id}`] : chosen), `${model.provider}/${model.id}`];
        listeners.forEach((listener) => listener());
      }),
      reset: vi.fn(() => { chosen = []; listeners.forEach((listener) => listener()); }),
    };
    const onSelect = vi.fn();
    render(<TestProviders>
      <ModelPicker models={models} activeKey="anthropic/claude-fable-5-1" onSelect={onSelect} onClose={vi.fn()} multiSelect={selection} anchor={{ current: null }} />
    </TestProviders>);
    fireEvent.click(screen.getByText("Claude Opus 5"), { shiftKey: true });
    expect(selection.toggle).toHaveBeenCalledWith(models[1], models[0], "pi", "pi");
    expect(onSelect).not.toHaveBeenCalled();
    expect(screen.getAllByText("added")).toHaveLength(2);
    expect(screen.getByText("2 models chosen")).toBeTruthy();
    fireEvent.click(screen.getByText("Claude Opus 5"));
    expect(selection.reset).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(models[1]);
  });

  it("makes a row the one 'Runs with' is for once the pointer rests on it, not while it passes", () => {
    vi.useFakeTimers();
    try {
      renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
      fireEvent.click(railButton("OpenAI"));
      const [, lunaRow] = screen.getAllByRole("option");
      fireEvent.mouseEnter(lunaRow!);
      fireEvent.mouseLeave(lunaRow!);
      act(() => { vi.advanceTimersByTime(300); });
      expect(ways()[0]).toBe("Pi, Plan ✓");
      fireEvent.mouseEnter(lunaRow!);
      act(() => { vi.advanceTimersByTime(300); });
      expect(ways()).toEqual(["Codex, Plan ✓"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("where the picker opens", () => {
  it("keeps the tablet picker as a popover and switches to a sheet in a narrow window, with Back and the thinking row", () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const profile = document.body.dataset.profile;
    document.body.dataset.profile = "compact";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
    const onOpenThinking = vi.fn();
    const onSelect = vi.fn();
    try {
      renderPicker({ onOpenThinking, onSelect });
      const picker = screen.getByRole("dialog", { name: "Select model" });
      expect(picker.classList.contains("model-picker-sheet")).toBe(false);
      expect(within(picker).queryByRole("button", { name: "Done" })).toBeNull();
      act(() => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
        window.dispatchEvent(new Event("resize"));
      });
      const page = screen.getByRole("dialog", { name: "Thread settings" });
      expect(page.classList.contains("mobile-page")).toBe(true);
      expect(within(page).getByRole("button", { name: "Back" })).toBeTruthy();
      fireEvent.change(within(page).getByRole("textbox", { name: "Find a model" }), { target: { value: "Fable" } });
      expect(within(page).getAllByRole("radio")).toHaveLength(1);
      fireEvent.click(within(page).getByRole("button", { name: "Favourite Claude Fable 5.1" }));
      fireEvent.click(within(page).getByRole("button", { name: "Show favourite models" }));
      fireEvent.click(within(page).getByRole("radio", { name: "Claude Fable 5.1" }));
      expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "claude-fable-5-1" }));
      fireEvent.click(within(page).getByRole("button", { name: /^Thinking and speed/u }));
      expect(onOpenThinking).toHaveBeenCalled();
    } finally {
      cleanup();
      if (width) Object.defineProperty(window, "innerWidth", width);
      if (profile === undefined) delete document.body.dataset.profile;
      else document.body.dataset.profile = profile;
    }
  });

  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;

  it("sits 6 px above the composer's frame at its left edge, not at the chip that opened it (design 1l)", () => {
    const frame = document.createElement("div");
    const chip = document.createElement("button");
    frame.append(chip);
    document.body.append(frame);
    frame.getBoundingClientRect = () => rect(260, 600, 360, 110);
    chip.getBoundingClientRect = () => rect(268, 660, 120, 28);
    const original = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      return this.classList.contains("popover") ? rect(0, 0, 460, 300) : original.call(this);
    };
    try {
      render(<TestProviders><ModelPicker models={models} onSelect={vi.fn()} onClose={() => {}} anchor={{ current: chip }} placeAgainst={{ current: frame }} /></TestProviders>);
      const popover = screen.getByRole("dialog", { name: "Select model" });
      expect(popover.style.left).toBe("260px");
      expect(popover.style.top).toBe(`${600 - 6 - 300}px`);
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
      frame.remove();
    }
  });

  it("asks every runtime for its models again from the options menu (K124)", async () => {
    const runtimeTools = vi.fn(async () => ({ tools: [], log: [] }));
    setHostClient({ runtimeTools } as unknown as HostClient);
    try {
      renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Sort and filter" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Refresh models" }));
      await waitFor(() => expect(runtimeTools).toHaveBeenCalledWith("refresh"));
    } finally {
      setHostClient(undefined);
    }
  });
});
