import { describe, expect, it, vi } from "vitest";
import type { ExtensionUiAnswer } from "../shared/contracts.js";
import { createExtensionUiContext, type ExtensionUiBridge } from "./extension-ui.js";

function makeBridge(): { bridge: ExtensionUiBridge; unsupported: ReturnType<typeof vi.fn> } {
  const unsupported = vi.fn();
  const bridge: ExtensionUiBridge = {
    sessionId: () => "session-1",
    ask: vi.fn(async (prompt): Promise<ExtensionUiAnswer> => {
      if (prompt.kind === "select") return { value: "option-1" };
      if (prompt.kind === "confirm") return { confirmed: true };
      if (prompt.kind === "input") return { value: "typed input" };
      if (prompt.kind === "editor") return { value: "edited text" };
      return { cancelled: true };
    }),
    notify: vi.fn(),
    setWindowTitle: vi.fn(),
    unsupported,
    setStatus: vi.fn(() => true),
    setWidget: vi.fn(() => true),
    setWorkingMessage: vi.fn(() => true),
    setFooter: vi.fn(() => true),
    setHeader: vi.fn(() => true),
    setEditorText: vi.fn(() => true),
    pasteToEditor: vi.fn(() => true),
    getEditorText: vi.fn(() => "current draft"),
    setToolsExpanded: vi.fn(() => true),
    getToolsExpanded: vi.fn(() => true),
  };
  return { bridge, unsupported };
}

describe("createExtensionUiContext", () => {
  it("routes select, confirm, input, and editor prompts to bridge.ask", async () => {
    const { bridge } = makeBridge();
    const ui = createExtensionUiContext(bridge);

    await expect(ui.select("Pick one", ["a", "b"])).resolves.toBe("option-1");
    await expect(ui.confirm("Are you sure?", "Please confirm")).resolves.toBe(true);
    await expect(ui.input("Enter value", "placeholder")).resolves.toBe("typed input");
    await expect(ui.editor("Edit code", "initial")).resolves.toBe("edited text");
  });

  it("handles notifications, title, and working messages", () => {
    const { bridge } = makeBridge();
    const ui = createExtensionUiContext(bridge);

    ui.notify("Test alert", "warning");
    expect(bridge.notify).toHaveBeenCalledWith("Test alert", "warning");

    ui.setTitle("New Title");
    expect(bridge.setWindowTitle).toHaveBeenCalledWith("New Title");

    ui.setWorkingMessage("Computing...");
    expect(bridge.setWorkingMessage).toHaveBeenCalledWith("Computing...");
  });

  it("routes setFooter, setHeader, setEditorText, pasteToEditor, and toolsExpanded to bridge", () => {
    const { bridge } = makeBridge();
    const ui = createExtensionUiContext(bridge);

    (ui.setFooter as any)(["Footer 1", "Footer 2"]);
    expect(bridge.setFooter).toHaveBeenCalledWith(["Footer 1", "Footer 2"]);

    (ui.setHeader as any)(["Header 1"]);
    expect(bridge.setHeader).toHaveBeenCalledWith(["Header 1"]);

    ui.setEditorText("hello world");
    expect(bridge.setEditorText).toHaveBeenCalledWith("hello world");

    ui.pasteToEditor(" append this");
    expect(bridge.pasteToEditor).toHaveBeenCalledWith(" append this");

    expect(ui.getEditorText()).toBe("current draft");
    expect(ui.getToolsExpanded()).toBe(true);

    ui.setToolsExpanded(false);
    expect(bridge.setToolsExpanded).toHaveBeenCalledWith(false);
  });

  it("reports unsupported terminal-specific methods once without throwing", () => {
    const { bridge, unsupported } = makeBridge();
    const ui = createExtensionUiContext(bridge);

    ui.setWorkingVisible(true);
    ui.setWorkingVisible(false);
    expect(unsupported).toHaveBeenCalledTimes(1);
    expect(unsupported).toHaveBeenCalledWith("ui.setWorkingVisible");

    ui.setWorkingIndicator({} as any);
    expect(unsupported).toHaveBeenCalledWith("ui.setWorkingIndicator");
  });

  it("handles custom component dialogs via ask", async () => {
    const { bridge } = makeBridge();
    (bridge.ask as any).mockResolvedValueOnce({ customResult: { answer: 42 } });
    const ui = createExtensionUiContext(bridge);

    const factory = vi.fn((_tui, _theme, _kb, _done) => ({
      render: () => ["line 1", "line 2"],
    }));

    const result = await ui.custom(factory as any);
    expect(factory).toHaveBeenCalled();
    expect(bridge.ask).toHaveBeenCalledWith(expect.objectContaining({
      kind: "custom",
      lines: ["line 1", "line 2"],
    }));
    expect(result).toEqual({ answer: 42 });
  });

  it("routes input and dynamic re-rendering for custom dialogs", async () => {
    const { bridge } = makeBridge();
    let capturedHandler: ((data: string) => void) | undefined;
    const cleanup = vi.fn();
    bridge.onCustomInput = vi.fn((_promptId, handler) => {
      capturedHandler = handler;
      return cleanup;
    });
    bridge.updateCustomPrompt = vi.fn();

    let renderCount = 0;
    const handleInput = vi.fn();
    let tuiRef: any;

    (bridge.ask as any).mockImplementationOnce(async (prompt: any) => {
      expect(prompt.lines).toEqual(["render-1"]);
      // Simulate input event from bridge
      capturedHandler?.("test-keystroke");
      // Trigger requestRender
      tuiRef.requestRender();
      return { value: "submit-data" };
    });

    const ui = createExtensionUiContext(bridge);
    const factory = vi.fn((tui, _theme, _kb, done) => {
      tuiRef = tui;
      return {
        render: () => {
          renderCount++;
          return [`render-${renderCount}`];
        },
        handleInput: (data: string) => {
          handleInput(data);
          if (data === "submit-data") {
            done({ completed: true });
          }
        },
      };
    });

    const result = await ui.custom(factory as any);
    expect(handleInput).toHaveBeenCalledWith("test-keystroke");
    expect(handleInput).toHaveBeenCalledWith("submit-data");
    expect(bridge.updateCustomPrompt).toHaveBeenCalledWith(expect.any(String), ["render-2"]);
    expect(cleanup).toHaveBeenCalled();
    expect(result).toEqual({ completed: true });
  });

  it("delegates autocomplete providers and theme operations to bridge", () => {
    const { bridge } = makeBridge();
    bridge.addAutocompleteProvider = vi.fn();
    bridge.getAllThemes = vi.fn(() => ["dark", "light", "nord"]);
    bridge.setTheme = vi.fn(() => ({ ok: true }));

    const ui = createExtensionUiContext(bridge);
    const provider = vi.fn();
    ui.addAutocompleteProvider(provider as any);
    expect(bridge.addAutocompleteProvider).toHaveBeenCalledWith(provider);

    expect(ui.getAllThemes()).toEqual(["dark", "light", "nord"]);
    expect(ui.setTheme("nord")).toEqual({ ok: true });
    expect(bridge.setTheme).toHaveBeenCalledWith("nord");
  });
});
