// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UiModel, UiRuntimeBackend } from "../../shared/contracts";
import { ModelPicker, type RuntimeAction } from "./ModelPicker";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";
import type { RuntimeCatalogEntry } from "../../workbench/runtime-catalog-store";

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
  onSelect?: (model: UiModel, runtime?: string) => void;
  catalogRuntime?: string;
  catalogs?: ReadonlyMap<string, RuntimeCatalogEntry>;
  runtimeBackends?: UiRuntimeBackend[];
  onSelectRuntime?: (kind: string) => void;
  onNewThreadOnRuntime?: (kind: string, model?: UiModel) => void;
  runtimeActions?: RuntimeAction[];
  activeKey?: string;
  list?: UiModel[];
} = {}) {
  const onSelect = options.onSelect ?? vi.fn();
  render(<TestProviders preferences={options.preferences}>
    <ModelPicker
      models={options.list ?? models}
      activeKey={options.activeKey}
      onSelect={onSelect}
      onClose={() => {}}
      anchor={{ current: null }}
      runtime={options.runtime}
      catalogRuntime={options.catalogRuntime}
      runtimeBackends={options.runtimeBackends}
      catalogs={options.catalogs}
      onSelectRuntime={options.onSelectRuntime}
      onNewThreadOnRuntime={options.onNewThreadOnRuntime}
      runtimeActions={options.runtimeActions}
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

const codexBackends = [...backends, { kind: "codex", label: "Codex" }];
const luna = { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription" as const, price: { input: 0.2, output: 1.2 }, contextWindow: 400_000 };
const cached = (entries: Array<[string, RuntimeCatalogEntry]>) => new Map(entries);
const codexReady = (list: UiModel[] = [luna]): [string, RuntimeCatalogEntry] => ["codex", { status: "ready", catalog: { kind: "codex", models: list, thinkingLevels: { "gpt-5.6-luna": ["low", "medium", "high"] } } }];
const search = () => screen.getByRole("combobox", { name: "Search models" });
const runtimeButton = (label: string) => screen.getByRole("button", { name: new RegExp(`^${label},`, "u") });
const optionNames = () => screen.queryAllByRole("option").map((option) => option.getAttribute("aria-label"));

describe("ModelPicker", () => {
  it("lists runtimes on the left with their state, and another runtime's models from the host's cache", () => {
    const onSelect = renderPicker({
      runtime: "pi",
      runtimeBackends: codexBackends,
      onSelectRuntime: vi.fn(),
      catalogs: cached([codexReady(), ["claude-code", { status: "unavailable", reason: "not-installed" }]]),
    });
    const column = screen.getByRole("navigation", { name: "Runtimes" });
    expect(within(column).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Favourites", "Pi, ready", "Claude Code, not installed", "Antigravity, models listed once a thread runs", "Codex, ready",
    ]);
    fireEvent.click(runtimeButton("Codex"));
    expect(screen.getByText("Choosing one runs this thread on Codex instead of Pi.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Start this thread on Codex" })).toBeTruthy();
    // A plan shows it is included, and what the model costs over its API.
    const row = screen.getByRole("option", { name: /GPT-5.6 Luna, Codex, Plan/u });
    expect(row.textContent).toContain("incl.");
    expect(row.textContent).toContain("API ≈ $0.2/$1.2");
    expect(row.textContent).toContain("400k");
    expect(row.querySelector(".model-levels")?.getAttribute("title")).toBe("Reasoning: low, medium, high");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(luna, "codex");
  });

  it("shows a provider column only for a runtime with several providers", () => {
    renderPicker({ runtime: "pi", runtimeBackends: codexBackends, catalogs: cached([codexReady()]) });
    const providers = screen.getByRole("navigation", { name: "Pi providers" });
    expect(within(providers).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["All providers (5)", "Anthropic (4)", "OpenAI (1)"]);
    fireEvent.click(within(providers).getByRole("button", { name: "OpenAI (1)" }));
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Pi"]);
    fireEvent.click(runtimeButton("Codex"));
    expect(screen.queryByRole("navigation", { name: /providers/u })).toBeNull();
  });

  it("searches every runtime at once and groups a model's offerings under it", () => {
    renderPicker({
      runtime: "pi",
      runtimeBackends: codexBackends,
      onSelectRuntime: vi.fn(),
      list: [...models, { ...luna, provider: "openai-codex" }],
      catalogs: cached([codexReady([luna, { ...luna, id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }])]),
    });
    fireEvent.change(search(), { target: { value: "luna" } });
    expect(screen.getByText("2 offerings")).toBeTruthy();
    expect(optionNames()).toEqual(["GPT-5.6 Luna, Pi, Plan", "GPT-5.6 Luna, Codex, Plan"]);
    fireEvent.change(search(), { target: { value: "sol" } });
    expect(optionNames()).toHaveLength(2);
  });

  it("sorts by price with every plan first, and by the API price within both groups", () => {
    const list: UiModel[] = [
      { provider: "openai", id: "o4-mini", name: "o4-mini", billing: "api-key", price: { input: 1.1, output: 4.4 } },
      { provider: "openai", id: "gpt-5.6-sol", name: "GPT-5.6 Sol", billing: "subscription", price: { input: 2, output: 12 } },
      { provider: "openai", id: "gpt-4.1-nano", name: "GPT-4.1 nano", billing: "api-key", price: { input: 0.1, output: 0.4 } },
      { provider: "openai", id: "gpt-5.6-luna", name: "GPT-5.6 Luna", billing: "subscription", price: { input: 0.2, output: 1.2 } },
    ];
    renderPicker({ list });
    fireEvent.click(screen.getByRole("button", { name: "Sort: Relevance" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Price/u }));
    expect(optionNames()).toEqual(["GPT-5.6 Luna, Pi, Plan", "GPT-5.6 Sol, Pi, Plan", "GPT-4.1 nano, Pi, API", "o4-mini, Pi, API"]);
    expect(screen.getAllByText("incl.")).toHaveLength(2);
    expect(screen.getByText("$0.1/$0.4")).toBeTruthy();
  });

  it("shows and sorts by the user's own price in place of the catalog's", () => {
    const list: UiModel[] = [
      { provider: "openai", id: "o4-mini", name: "o4-mini", billing: "api-key", price: { input: 1.1, output: 4.4 } },
      { provider: "openai", id: "gpt-4.1-nano", name: "GPT-4.1 nano", billing: "api-key", price: { input: 0.1, output: 0.4 } },
    ];
    const preferences = new PreferencesStore();
    preferences.applyConfig({ modelPrices: { "openai/o4-mini": { input: 0.01, output: 0.02 } } });
    renderPicker({ list, preferences });
    fireEvent.click(screen.getByRole("button", { name: "Sort: Relevance" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Price/u }));
    expect(optionNames()).toEqual(["o4-mini, Pi, API", "GPT-4.1 nano, Pi, API"]);
    expect(screen.getByText("$0.01/$0.02").closest(".model-price")?.getAttribute("title")).toContain("(your price)");
  });

  it("filters by billing and hides a model until the hidden ones are shown", () => {
    const preferences = new PreferencesStore();
    renderPicker({ preferences });
    fireEvent.click(screen.getByRole("button", { name: "Filter" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    expect(optionNames()).toEqual(["Claude Fable 5.1, Pi, Plan"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Claude Opus 5 from the picker" }));
    expect(preferences.getSnapshot().modelPreferences.pi).toEqual({ hidden: ["anthropic/claude-opus-5"] });
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /1 hidden · show/u }));
    expect(screen.getByRole("option", { name: /^Claude Opus 5/u }).textContent).toContain("hidden");
  });

  it("says why a runtime lists no models instead of an empty list", () => {
    renderPicker({
      runtime: "pi",
      runtimeBackends: codexBackends,
      onSelectRuntime: vi.fn(),
      catalogs: cached([
        ["codex", { status: "unavailable", reason: "not-installed", message: "The Codex CLI \"codex\" is not installed." }],
        ["claude-code", { status: "loading" }],
      ]),
    });
    fireEvent.click(runtimeButton("Codex"));
    expect(screen.getByRole("region", { name: "Codex" }).textContent).toMatch(/is not installed/u);
    fireEvent.click(runtimeButton("Claude Code"));
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toMatch(/Asking Claude Code for its models/u);
  });

  it("offers another runtime to a new thread from its entry", () => {
    const onSelectRuntime = vi.fn();
    const onSelect = renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime });
    fireEvent.click(runtimeButton("Claude Code"));
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toMatch(/runs the thread instead of Pi/u);
    fireEvent.click(screen.getByRole("button", { name: "Start this thread on Claude Code" }));
    expect(onSelectRuntime).toHaveBeenCalledWith("claude-code");
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says on a runtime's entry that its program has an update, and how to install it", () => {
    const codex = { kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex" } };
    renderPicker({ runtime: "pi", runtimeBackends: [...backends, codex], onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    const entry = runtimeButton("Codex");
    expect(entry.getAttribute("aria-label")).toBe("Codex, update available");
    expect(entry.getAttribute("title")).toBe("Codex · update available");
    fireEvent.click(entry);
    expect(screen.getByRole("status").textContent).toBe("Codex 0.155.1 is out; 0.154.0 is installed. Update with brew upgrade --cask codex.");
  });

  it("opens a draft bound for another runtime on that runtime, with Pi's models a click away", () => {
    renderPicker({ runtime: "claude-code", catalogRuntime: "pi", runtimeBackends: backends, onSelectRuntime: vi.fn() });
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toMatch(/starts on Claude Code with its default model/u);
    fireEvent.click(runtimeButton("Pi"));
    expect(screen.getByText("Claude Opus 5")).toBeTruthy();
  });

  it("offers a thread that exists a new thread on another runtime, and what kits do with one", () => {
    const onNewThreadOnRuntime = vi.fn();
    const run = vi.fn();
    const onSelect = renderPicker({
      runtime: "pi", runtimeBackends: codexBackends, onNewThreadOnRuntime,
      runtimeActions: [{ id: "handoff.continue-in", label: "Continue in", run }],
      catalogs: cached([codexReady()]),
    });
    fireEvent.click(runtimeButton("Antigravity"));
    expect(screen.getByRole("region", { name: "Antigravity" }).textContent).toMatch(/a thread keeps the runtime it started on/u);
    fireEvent.click(screen.getByRole("button", { name: "Continue in Antigravity" }));
    expect(run).toHaveBeenCalledWith("antigravity");
    cleanup();
    renderPicker({ runtime: "pi", runtimeBackends: codexBackends, onNewThreadOnRuntime, runtimeActions: [{ id: "x", label: "Continue in", run }], catalogs: cached([codexReady()]), onSelect });
    fireEvent.click(runtimeButton("Codex"));
    expect(screen.getByText(/Choosing one starts a new thread on Codex; this one stays on Pi./u)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue in Codex" })).toBeTruthy();
    fireEvent.click(runtimeButton("Antigravity"));
    fireEvent.click(screen.getByRole("button", { name: "New thread on Antigravity" }));
    expect(onNewThreadOnRuntime).toHaveBeenCalledWith("antigravity");
  });

  it("folds a runtime's legacy models behind one row and badges the newest", () => {
    renderPicker();
    expect(screen.getByText("NEW")).toBeTruthy();
    expect(screen.queryByText("Claude Opus 4.1")).toBeNull();
    const fold = screen.getByRole("option", { name: /Legacy models/u });
    expect(fold.textContent).toContain("2 models");
    fireEvent.click(fold);
    expect(screen.getByText("Claude Opus 4.1")).toBeTruthy();
  });

  it("lists legacy models flat while searching, tagged", () => {
    renderPicker();
    fireEvent.change(search(), { target: { value: "sonnet" } });
    expect(screen.getByText("Claude Sonnet 4.5")).toBeTruthy();
    expect(screen.getByText("legacy")).toBeTruthy();
    expect(screen.queryByText("Legacy models")).toBeNull();
  });

  it("reaches the n-th favourite of any runtime with ⌘n and lists favourites together", () => {
    const preferences = new PreferencesStore();
    preferences.toggleFavouriteModel("openai-codex/gpt-5.6-sol");
    preferences.toggleFavouriteModel("codex:openai/gpt-5.6-luna");
    const onSelect = renderPicker({ preferences, runtime: "pi", runtimeBackends: codexBackends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    fireEvent.click(screen.getByRole("button", { name: "Favourites" }));
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Pi", "GPT-5.6 Luna, Codex, Plan"]);
    expect(screen.getByText("⌘2")).toBeTruthy();
    fireEvent.keyDown(search(), { key: "2", metaKey: true });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "gpt-5.6-luna" }), "codex");
    expect(preferences.getSnapshot().recentModels).toEqual(["codex:openai/gpt-5.6-luna"]);
  });

  it("moves between columns with the arrows and hands typing to the search field", () => {
    renderPicker({ runtime: "pi", runtimeBackends: codexBackends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    const input = search();
    input.focus();
    // Left from the field: the provider column, then the runtimes.
    fireEvent.keyDown(input, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("All providers (5)");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Anthropic (4)");
    expect(optionNames()).not.toContain("GPT-5.6 Sol, Pi");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Pi, ready");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Favourites");
    fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Codex, ready");
    expect(optionNames()).toEqual(["GPT-5.6 Luna, Codex, Plan"]);
    fireEvent.keyDown(document.activeElement!, { key: "l" });
    expect(document.activeElement).toBe(input);
    expect((input as HTMLInputElement).value).toBe("l");
  });

  it("walks the list with the arrows, over group headings, and takes a row with Enter", () => {
    const onSelect = renderPicker({ list: [{ ...luna, provider: "openai-codex" }], runtime: "pi", runtimeBackends: codexBackends, onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    fireEvent.change(search(), { target: { value: "luna" } });
    const input = search();
    expect(input.getAttribute("aria-activedescendant")).toBe("model-option-1");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("model-option-2");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("model-option-1");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith(luna, "codex");
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
    const onClose = vi.fn();
    render(<TestProviders>
      <ModelPicker models={models} activeKey="anthropic/claude-sonnet-4-5" onSelect={onSelect} onClose={onClose} multiSelect={selection} anchor={{ current: null }} />
    </TestProviders>);

    fireEvent.click(screen.getByText("Claude Opus 5"), { shiftKey: true });
    expect(selection.toggle).toHaveBeenCalledWith(models[1], models[3]);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getAllByText("added")).toHaveLength(2);
    expect(screen.getByText("2 models chosen")).toBeTruthy();

    fireEvent.click(screen.getByText("Claude Opus 4.1"));
    expect(selection.reset).toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith(models[2]);
  });

  it("treats a Shift-click as a plain pick when nobody keeps a model set", () => {
    const onSelect = renderPicker();
    fireEvent.click(screen.getByText("Claude Opus 5"), { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith(models[1]);
  });
});
