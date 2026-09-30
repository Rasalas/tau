// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeAll, afterAll, afterEach, describe, expect, it, vi } from "vitest";
import type { UiModel, UiRuntimeBackend } from "../../shared/contracts";
import { ModelPicker, type RuntimeAction, type ThinkingChoice } from "./ModelPicker";
import { PreferencesStore } from "../preferences";
import { TestProviders } from "../test-support/test-providers";
import { declareRuntimeMarks } from "../runtime-marks";
import { BUNDLED_RUNTIME_MARKS } from "../test-support/runtime-marks";
import { setHostClient } from "../host-client-context";
import type { HostClient } from "../../workbench/host-client";

beforeAll(() => declareRuntimeMarks(BUNDLED_RUNTIME_MARKS));
afterAll(() => declareRuntimeMarks([]));
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
  onClose?: () => void;
  thinking?: ThinkingChoice;
  onOpenSettings?: (kind: string, part: "runtime" | "models") => void;
} = {}) {
  const onSelect = options.onSelect ?? vi.fn();
  render(<TestProviders preferences={options.preferences}>
    <ModelPicker
      models={options.list ?? models}
      activeKey={options.activeKey}
      onSelect={onSelect}
      onClose={options.onClose ?? (() => {})}
      anchor={{ current: null }}
      thinking={options.thinking}
      onOpenSettings={options.onOpenSettings}
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
const detail = () => document.querySelector(".model-detail")?.textContent ?? "";
const providerGroup = () => screen.getByRole("group", { name: "Pi providers" });

describe("ModelPicker", () => {
  it("lists runtimes on the left with their state, and another runtime's models from the host's cache", () => {
    const onSelectRuntime = vi.fn();
    const onSelect = renderPicker({
      runtime: "pi",
      runtimeBackends: codexBackends,
      onSelectRuntime,
      catalogs: cached([codexReady(), ["claude-code", { status: "unavailable", reason: "not-installed" }]]),
    });
    const column = screen.getByRole("navigation", { name: "Runtimes" });
    expect(within(column).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual([
      "Favourites", "Pi, ready", "Claude Code, not installed", "Antigravity, models listed once a thread runs", "Codex, ready",
    ]);
    // One click on a runtime moves the draft there.
    fireEvent.click(runtimeButton("Codex"));
    expect(onSelectRuntime).toHaveBeenCalledWith("codex");
    expect(screen.getByRole("region", { name: "Models" }).querySelector(".model-column-title")?.textContent).toBe("Codex");
    // Context and price are no columns: the detail line says them for the row under the cursor.
    const row = screen.getByRole("option", { name: /GPT-5.6 Luna, Codex, Plan/u });
    expect(row.textContent).not.toMatch(/400k|\$/u);
    fireEvent.mouseMove(row);
    expect(detail()).toBe("gpt-5.6-luna400k contextin the planAPI ≈ $0.2/$1.2 per MTok");
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith(luna, "codex");
  });

  it("shows a runtime's providers as marks only when it has several", () => {
    renderPicker({ runtime: "pi", runtimeBackends: codexBackends, catalogs: cached([codexReady()]) });
    const providers = providerGroup();
    expect(within(providers).getAllByRole("button").map((button) => button.getAttribute("aria-label"))).toEqual(["All providers (5)", "Anthropic (4)", "ChatGPT plan (1)"]);
    fireEvent.click(within(providers).getByRole("button", { name: "ChatGPT plan (1)" }));
    expect(optionNames()).toEqual(["GPT-5.6 Sol, Pi"]);
    fireEvent.click(runtimeButton("Codex"));
    expect(screen.queryByRole("group", { name: /providers/u })).toBeNull();
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
    expect(document.querySelector(".model-group")?.textContent).toBe("GPT-5.6 Luna2");
    expect(optionNames()).toEqual(["GPT-5.6 Luna, Pi, Plan", "GPT-5.6 Luna, Codex, Plan"]);
    expect(screen.getByRole("region", { name: "Models" }).querySelector(".model-column-title")?.textContent).toBe("Every runtime");
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
    fireEvent.click(screen.getByRole("button", { name: "Sort and filter" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Price/u }));
    expect(optionNames()).toEqual(["GPT-5.6 Luna, Pi, Plan", "GPT-5.6 Sol, Pi, Plan", "GPT-4.1 nano, Pi, API", "o4-mini, Pi, API"]);
    expect(screen.getByRole("button", { name: "Sort and filter (1 on)" })).toBeTruthy();
    fireEvent.mouseMove(screen.getByRole("option", { name: "GPT-4.1 nano, Pi, API" }));
    expect(detail()).toContain("$0.1/$0.4 per MTok");
  });

  it("shows and sorts by the user's own price in place of the catalog's", () => {
    const list: UiModel[] = [
      { provider: "openai", id: "o4-mini", name: "o4-mini", billing: "api-key", price: { input: 1.1, output: 4.4 } },
      { provider: "openai", id: "gpt-4.1-nano", name: "GPT-4.1 nano", billing: "api-key", price: { input: 0.1, output: 0.4 } },
    ];
    const preferences = new PreferencesStore();
    preferences.applyConfig({ modelPrices: { "openai/o4-mini": { input: 0.01, output: 0.02 } } });
    renderPicker({ list, preferences });
    fireEvent.click(screen.getByRole("button", { name: "Sort and filter" }));
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Price/u }));
    expect(optionNames()).toEqual(["o4-mini, Pi, API", "GPT-4.1 nano, Pi, API"]);
    expect(detail()).toContain("$0.01/$0.02 per MTok (your price)");
  });

  it("filters by billing and hides a model until the hidden ones are shown", () => {
    const preferences = new PreferencesStore();
    renderPicker({ preferences });
    fireEvent.click(screen.getByRole("button", { name: "Sort and filter" }));
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    expect(optionNames()).toEqual(["Claude Fable 5.1, Pi, Plan"]);
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: "Plan" }));
    fireEvent.click(screen.getByRole("button", { name: "Hide Claude Opus 5 from the picker" }));
    expect(preferences.getSnapshot().modelPreferences.pi).toEqual({ hidden: ["anthropic/claude-opus-5"] });
    expect(screen.queryByText("Claude Opus 5")).toBeNull();
    fireEvent.click(screen.getByRole("menuitemcheckbox", { name: /Show hidden models/u }));
    expect(screen.getByRole("option", { name: /^Claude Opus 5/u }).textContent).toContain("hidden");
  });

  it("shows runtimes and providers as marks only, named in their tooltips", () => {
    renderPicker({
      runtime: "pi",
      runtimeBackends: [...codexBackends, { kind: "codex@work", label: "Codex · work" }],
      onSelectRuntime: vi.fn(),
      list: [...models, { provider: "radius", id: "r-1", name: "Radius One" }],
      catalogs: cached([codexReady(), ["claude-code", { status: "unavailable", reason: "not-installed", message: "The CLI is not on the PATH." }]]),
    });
    const rail = screen.getByRole("navigation", { name: "Runtimes" });
    const providers = providerGroup();
    for (const column of [rail, providers]) {
      expect(column.textContent).not.toMatch(/Favourites|Pi|Claude|Codex|Antigravity|providers|Anthropic|OpenAI|ChatGPT|radius|\d/u);
    }
    const tips = (column: HTMLElement) => within(column).getAllByRole("button").map((button) => button.getAttribute("data-tooltip"));
    expect(tips(rail)).toEqual([
      "Favourites · pinned models of every runtime", "Pi · ready · 6 models", "Claude Code · not installed\nThe CLI is not on the PATH.", "Antigravity · run this thread on it", "Codex · ready · 1 model", "Codex · work · run this thread on it",
    ]);
    // A second instance wears its initials on the program's mark.
    expect(within(rail).getByRole("button", { name: /^Codex · work,/u }).querySelector(".rail-instance")?.textContent).toBe("W");
    expect(tips(providers)).toEqual(["All providers · 6 models", "Anthropic · 4 models", "ChatGPT plan · 1 model", "radius · 1 model"]);
    // A provider without a mark gets its monogram.
    expect(within(providers).getByRole("button", { name: "radius (1)" }).querySelector(".provider-icon-fallback")?.textContent).toBe("R");
    // A row names its provider by its mark, not in text.
    const row = screen.getByRole("option", { name: /^Claude Opus 5, Pi/u });
    expect(row.textContent).not.toContain("Anthropic");
    expect(row.querySelector("[data-tooltip='Claude Opus 5 · Pi via Anthropic']")).toBeTruthy();
  });

  it("marks the runtime and provider of an offering in search instead of naming them", () => {
    const preferences = new PreferencesStore();
    preferences.toggleFavouriteModel("codex:openai/gpt-5.6-luna");
    renderPicker({
      preferences,
      runtime: "pi",
      runtimeBackends: codexBackends,
      onSelectRuntime: vi.fn(),
      list: [...models, { ...luna, provider: "openai-codex" }],
      catalogs: cached([codexReady([luna, { ...luna, id: "gpt-5.6-sol", name: "GPT-5.6 Sol" }])]),
    });
    fireEvent.change(search(), { target: { value: "luna" } });
    const pi = screen.getByRole("option", { name: "GPT-5.6 Luna, Pi, Plan" });
    const codex = screen.getByRole("option", { name: "GPT-5.6 Luna, Codex, Plan" });
    for (const row of [pi, codex]) {
      expect(row.textContent).not.toMatch(/Pi|Codex|OpenAI/u);
    }
    const marks = (row: HTMLElement) => [...row.querySelectorAll("[data-tooltip]")].map((mark) => mark.getAttribute("data-tooltip"));
    expect(marks(pi)).toEqual(["GPT-5.6 Luna · Pi via ChatGPT plan"]);
    expect(marks(codex)).toEqual(["GPT-5.6 Luna · Codex (OpenAI)"]);
    // A list across runtimes: the access mark with the runtime's badge, or the runtime's own mark at home.
    fireEvent.change(search(), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Favourites" }));
    const favourite = screen.getByRole("option", { name: /^GPT-5.6 Luna, Codex/u });
    expect(favourite.textContent).not.toMatch(/Codex|OpenAI/u);
    expect(marks(favourite)).toEqual(["GPT-5.6 Luna · Codex (OpenAI)"]);
  });

  it("says each thing once: no billing badge beside the price, no counts, a dot only for a runtime that is not ready", () => {
    renderPicker({
      runtime: "pi",
      runtimeBackends: codexBackends,
      onSelectRuntime: vi.fn(),
      catalogs: cached([codexReady(), ["claude-code", { status: "unavailable", reason: "not-installed" }]]),
    });
    const rail = screen.getByRole("navigation", { name: "Runtimes" });
    expect(runtimeButton("Pi").querySelector(".runtime-dot")).toBeNull();
    expect(runtimeButton("Claude Code").querySelector(".runtime-dot-not-installed")).toBeTruthy();
    expect(document.querySelector(".model-picker-content")?.textContent).not.toMatch(/\d+ models? · \d+ runtimes?/u);
    // The plan's mark says a plan pays; the row says it in no word.
    const fable = screen.getByRole("option", { name: "Claude Fable 5.1, Pi, Plan" });
    expect(fable.textContent).not.toContain("Plan");
    // Across providers a row wears its provider's mark, a plan's for a plan; within one provider it needs none.
    expect(fable.querySelector("[data-tooltip='Claude Fable 5.1 · Pi via Claude plan']")).toBeTruthy();
    fireEvent.click(within(providerGroup()).getByRole("button", { name: "Anthropic (4)" }));
    expect(screen.getByRole("option", { name: "Claude Fable 5.1, Pi, Plan" }).querySelector(".model-marks")).toBeNull();
    fireEvent.click(within(rail).getByRole("button", { name: /^Codex,/u }));
    expect(screen.getByRole("option", { name: "GPT-5.6 Luna, Codex, Plan" }).querySelector(".model-marks")).toBeNull();
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

  it("moves a new thread to another runtime with one click on its entry", () => {
    const onSelectRuntime = vi.fn();
    const onSelect = renderPicker({ runtime: "pi", runtimeBackends: backends, onSelectRuntime });
    fireEvent.click(runtimeButton("Claude Code"));
    expect(onSelectRuntime).toHaveBeenCalledWith("claude-code");
    expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toMatch(/can run this thread/u);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("says on a runtime's entry that its program has an update, and how to install it", () => {
    const codex = { kind: "codex", label: "Codex", version: { tool: "codex", installed: "0.154.0", latest: "0.155.1", updateCommand: "brew upgrade --cask codex" } };
    renderPicker({ runtime: "pi", runtimeBackends: [...backends, codex], onSelectRuntime: vi.fn(), catalogs: cached([codexReady()]) });
    const entry = runtimeButton("Codex");
    expect(entry.getAttribute("aria-label")).toBe("Codex, update available");
    expect(entry.getAttribute("data-tooltip")).toBe("Codex · update available · 1 model");
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
    expect(fold.textContent).toBe("Legacy models 2");
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
    // Left from the field: the runtimes.
    fireEvent.keyDown(input, { key: "ArrowLeft" });
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
    expect(selection.toggle).toHaveBeenCalledWith(models[1], models[3], "pi", "pi");
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
  describe("in three columns", () => {
    const reasoner: UiModel = { provider: "anthropic", id: "claude-reasoner", name: "Reasoner", reasoning: true };
    const plain: UiModel = { provider: "anthropic", id: "claude-plain", name: "Plain", reasoning: false };
    const gpt55 = { provider: "openai", id: "gpt-5.5", name: "GPT-5.5", billing: "subscription" as const };
    const astra = { provider: "openai", id: "gpt-6-astra", name: "GPT-6 Astra", billing: "subscription" as const };
    const terra = { provider: "openai", id: "gpt-5.6-terra", name: "GPT-5.6 Terra", billing: "subscription" as const };
    const codexCatalog = (): [string, RuntimeCatalogEntry] => ["codex", { status: "ready", catalog: {
      kind: "codex", models: [luna, gpt55, astra, terra],
      thinkingLevels: { "gpt-5.6-luna": ["low", "medium", "high"], "gpt-5.5": ["low", "medium"], "gpt-6-astra": ["low", "medium", "high", "max"], "gpt-5.6-terra": ["low"] },
    } }];
    const levelNames = () => within(screen.getByRole("radiogroup")).getAllByRole("radio").map((radio) => radio.textContent);

    it("takes the keyboard from search to model to thinking: type, Enter, arrows, a level", async () => {
      const onClose = vi.fn();
      const onLevel = vi.fn();
      const onSelect = vi.fn();
      const picker = (activeKey: string, thinking: ThinkingChoice) => <TestProviders>
        <ModelPicker models={[plain, reasoner]} activeKey={activeKey} thinking={thinking} onSelect={onSelect} onClose={onClose} anchor={{ current: null }} />
      </TestProviders>;
      const { rerender } = render(picker("anthropic/claude-plain", { levels: ["off"], level: "off", onSelect: onLevel }));
      const input = search();
      input.focus();
      fireEvent.change(input, { target: { value: "reas" } });
      expect(optionNames()).toEqual(["Reasoner, Pi"]);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(onSelect).toHaveBeenCalledWith(reasoner);
      // A level is still to choose: the picker stays, and the focus moves to the third column once the thread reports the levels.
      expect(onClose).not.toHaveBeenCalled();
      rerender(picker("anthropic/claude-reasoner", { levels: ["off", "low", "medium", "high"], level: "medium", onSelect: onLevel }));
      await waitFor(() => expect(document.activeElement?.getAttribute("role")).toBe("radio"));
      expect(screen.getByRole("radiogroup", { name: "Thinking for Reasoner" })).toBeTruthy();
      fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(input);
      // Right from the end of the field: the third column again.
      fireEvent.keyDown(input, { key: "ArrowRight" });
      expect(document.activeElement?.getAttribute("role")).toBe("radio");
      fireEvent.click(document.activeElement!);
      expect(onLevel).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("closes on a model with nothing left to choose", () => {
      const onClose = vi.fn();
      const onSelect = renderPicker({ list: [plain, reasoner], activeKey: "anthropic/claude-reasoner", onClose, thinking: { levels: ["low", "medium", "high"], level: "medium", onSelect: vi.fn() } });
      fireEvent.click(screen.getByRole("option", { name: "Plain, Pi" }));
      expect(onSelect).toHaveBeenCalledWith(plain);
      expect(onClose).toHaveBeenCalledOnce();
    });

    it("shows the thinking levels of each model, the chosen one's before the thread reports it", () => {
      const onLevel = vi.fn();
      const onClose = vi.fn();
      const onSelect = renderPicker({
        runtime: "codex", catalogRuntime: "codex", runtimeBackends: codexBackends, list: [luna, gpt55, astra, terra],
        activeKey: "openai/gpt-5.6-luna", catalogs: cached([codexCatalog()]), onClose,
        thinking: { levels: ["low", "medium", "high"], level: "medium", onSelect: onLevel },
      });
      expect(levelNames()).toEqual(["Low", "Medium", "High"]);
      expect(screen.getByRole("radio", { name: /Medium/u }).getAttribute("aria-checked")).toBe("true");
      fireEvent.click(screen.getByRole("option", { name: /^GPT-6 Astra, Codex/u }));
      expect(onSelect).toHaveBeenCalledWith(astra);
      expect(onClose).not.toHaveBeenCalled();
      expect(levelNames()).toEqual(["Low", "Medium", "High", "Max"]);
      fireEvent.click(screen.getByRole("radio", { name: "Max" }));
      expect(onLevel).toHaveBeenCalledWith("max");
      expect(onClose).toHaveBeenCalledOnce();
      cleanup();
      // One level is no choice: the model is taken and the picker closes.
      const closed = vi.fn();
      renderPicker({
        runtime: "codex", catalogRuntime: "codex", runtimeBackends: codexBackends, list: [luna, terra],
        activeKey: "openai/gpt-5.6-luna", catalogs: cached([codexCatalog()]), onClose: closed,
        thinking: { levels: ["low", "medium", "high"], level: "medium", onSelect: vi.fn() },
      });
      fireEvent.click(screen.getByRole("option", { name: /^GPT-5.6 Terra, Codex/u }));
      expect(closed).toHaveBeenCalledOnce();
    });

    it("says why a runtime sets no thinking here", () => {
      renderPicker({ thinking: { levels: [], note: "Codex sets thinking once this thread exists." } });
      expect(screen.getByRole("region", { name: "Thinking" }).textContent).toContain("Codex sets thinking once this thread exists.");
      expect(screen.queryByRole("radiogroup")).toBeNull();
    });

    it("preselects the model in use, and on another runtime the one last chosen there, pinned ones first", () => {
      const preferences = new PreferencesStore();
      preferences.toggleFavouriteModel("codex:openai/gpt-6-astra");
      preferences.noteModelUsed("codex:openai/gpt-5.5");
      renderPicker({
        preferences, runtime: "pi", activeKey: "anthropic/claude-opus-5", runtimeBackends: codexBackends,
        onNewThreadOnRuntime: vi.fn(), catalogs: cached([codexCatalog()]),
      });
      const input = search();
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.getAttribute("aria-label")).toBe("Claude Opus 5, Pi, in use");
      fireEvent.click(runtimeButton("Codex"));
      expect(optionNames()).toEqual(["GPT-5.5, Codex, Plan", "GPT-6 Astra, Codex, Plan", "Show all 4"]);
      expect(document.getElementById(input.getAttribute("aria-activedescendant")!)?.getAttribute("aria-label")).toBe("GPT-5.5, Codex, Plan");
      fireEvent.click(screen.getByRole("option", { name: "Show all 4" }));
      expect(optionNames()).toEqual(["GPT-5.5, Codex, Plan", "GPT-6 Astra, Codex, Plan", "Pinned only", "GPT-5.6 Luna, Codex, Plan", "GPT-5.6 Terra, Codex, Plan"]);
      // Recent sits at the bottom, one click each.
      expect(screen.getByRole("button", { name: "GPT-5.5, Codex" }).closest(".model-recent")).toBeTruthy();
    });

    it("dims a runtime that cannot run a thread and says why, with the way to fix it", () => {
      const onOpenSettings = vi.fn();
      const onSelectRuntime = vi.fn();
      const onClose = vi.fn();
      renderPicker({
        runtime: "pi", runtimeBackends: codexBackends, onSelectRuntime, onOpenSettings, onClose,
        catalogs: cached([["claude-code", { status: "unavailable", reason: "sign-in-required", message: "Run the login to use your plan." }], ["codex", { status: "unavailable", reason: "not-installed" }]]),
      });
      const entry = runtimeButton("Claude Code");
      expect(entry.classList).toContain("blocked");
      expect(runtimeButton("Pi").classList).not.toContain("blocked");
      fireEvent.click(entry);
      // A draft stays where it is: the runtime cannot take it yet.
      expect(onSelectRuntime).not.toHaveBeenCalled();
      expect(screen.getByRole("region", { name: "Claude Code" }).textContent).toContain("Run the login to use your plan.");
      fireEvent.click(screen.getByRole("button", { name: "Sign in to Claude Code…" }));
      expect(onOpenSettings).toHaveBeenCalledWith("claude-code", "runtime");
      expect(onClose).toHaveBeenCalledOnce();
      fireEvent.click(runtimeButton("Codex"));
      expect(screen.getByRole("button", { name: "Install Codex…" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Pin models in Settings" }));
      expect(onOpenSettings).toHaveBeenLastCalledWith("codex", "models");
    });
  });
});

describe("where the picker opens", () => {
  it("keeps the tablet picker as a popover and switches to a sheet in a narrow window", () => {
    const width = Object.getOwnPropertyDescriptor(window, "innerWidth");
    const profile = document.body.dataset.profile;
    document.body.dataset.profile = "compact";
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 820 });
    try {
      renderPicker();
      const picker = screen.getByRole("dialog", { name: "Select model" });
      expect(picker.classList.contains("model-picker-sheet")).toBe(false);
      expect(within(picker).queryByRole("button", { name: "Close" })).toBeNull();
      act(() => {
        Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
        window.dispatchEvent(new Event("resize"));
      });
      expect(picker.classList.contains("model-picker-sheet")).toBe(true);
      expect(within(picker).getByRole("button", { name: "Close" })).toBeTruthy();
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

  it("asks every runtime for its models again from the footer (K124)", async () => {
    const runtimeTools = vi.fn(async () => ({ tools: [], log: [] }));
    setHostClient({ runtimeTools } as unknown as HostClient);
    try {
      renderPicker();
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      expect(screen.getByRole("button", { name: "Refreshing…" })).toHaveProperty("disabled", true);
      await waitFor(() => expect(runtimeTools).toHaveBeenCalledWith("refresh"));
      await screen.findByRole("button", { name: "Refresh" });
    } finally {
      setHostClient(undefined);
    }
  });
});
