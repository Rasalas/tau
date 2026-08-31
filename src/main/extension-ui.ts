import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiAnswer, ExtensionUiPrompt, ExtensionUiPromptKind } from "../shared/contracts.js";

export interface ExtensionUiBridge {
  /** The thread the prompt belongs to; only that thread is blocked by it. */
  sessionId(): string;
  ask(prompt: ExtensionUiPrompt): Promise<ExtensionUiAnswer>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setWindowTitle(title: string): void;
  /** Reports a capability Tau cannot render, instead of failing silently. */
  unsupported(method: string): void;
}

interface DialogOptions {
  signal?: AbortSignal;
  timeout?: number;
}

function promptId(): string {
  return `eui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Pi installs a no-op UI context unless the host supplies one, which makes every
 * extension question resolve to "cancelled" without a trace. This implements the
 * context for Tau: the four blocking dialogs are answered by the workbench, and
 * anything that can only exist in a terminal is reported rather than swallowed.
 */
export function createExtensionUiContext(bridge: ExtensionUiBridge): ExtensionUIContext {
  const reported = new Set<string>();
  const unsupported = (method: string) => {
    if (reported.has(method)) return;
    reported.add(method);
    bridge.unsupported(method);
  };

  async function ask<T>(
    kind: ExtensionUiPromptKind,
    fields: Omit<ExtensionUiPrompt, "id" | "sessionId" | "kind" | "expiresAt">,
    options: DialogOptions | undefined,
    read: (answer: ExtensionUiAnswer) => T,
    fallback: T,
  ): Promise<T> {
    if (options?.signal?.aborted) return fallback;
    const prompt: ExtensionUiPrompt = {
      id: promptId(),
      sessionId: bridge.sessionId(),
      kind,
      ...fields,
      ...(options?.timeout ? { expiresAt: Date.now() + options.timeout } : {}),
    };
    try {
      return read(await bridge.ask(prompt));
    } catch {
      return fallback;
    }
  }

  return {
    select: (title: string, options: string[], opts?: DialogOptions) =>
      ask("select", { title, options: [...options] }, opts,
        (answer) => ("value" in answer ? answer.value : undefined), undefined),

    confirm: (title: string, message: string, opts?: DialogOptions) =>
      ask("confirm", { title, message }, opts,
        (answer) => ("confirmed" in answer ? answer.confirmed : false), false),

    input: (title: string, placeholder?: string, opts?: DialogOptions) =>
      ask("input", { title, placeholder }, opts,
        (answer) => ("value" in answer ? answer.value : undefined), undefined),

    editor: (title: string, prefill?: string) =>
      ask("editor", { title, prefill }, undefined,
        (answer) => ("value" in answer ? answer.value : undefined), undefined),

    notify: (message: string, type?: "info" | "warning" | "error") => bridge.notify(message, type ?? "info"),
    setTitle: (title: string) => bridge.setWindowTitle(title),

    // Terminal-only surfaces. Tau has no TUI to draw into, so these are reported
    // once each and otherwise inert; the documented return values are preserved.
    custom: async <T,>(): Promise<T> => {
      unsupported("ui.custom");
      return undefined as T;
    },
    onTerminalInput: () => { unsupported("ui.onTerminalInput"); return () => {}; },
    setWidget: () => unsupported("ui.setWidget"),
    setFooter: () => unsupported("ui.setFooter"),
    setHeader: () => unsupported("ui.setHeader"),
    setStatus: () => unsupported("ui.setStatus"),
    setWorkingMessage: () => unsupported("ui.setWorkingMessage"),
    setWorkingVisible: () => unsupported("ui.setWorkingVisible"),
    setWorkingIndicator: () => unsupported("ui.setWorkingIndicator"),
    setHiddenThinkingLabel: () => unsupported("ui.setHiddenThinkingLabel"),
    pasteToEditor: () => unsupported("ui.pasteToEditor"),
    setEditorText: () => unsupported("ui.setEditorText"),
    getEditorText: () => { unsupported("ui.getEditorText"); return ""; },
    addAutocompleteProvider: () => unsupported("ui.addAutocompleteProvider"),
    setEditorComponent: () => unsupported("ui.setEditorComponent"),
    getEditorComponent: () => { unsupported("ui.getEditorComponent"); return undefined; },
    getToolsExpanded: () => false,
    setToolsExpanded: () => unsupported("ui.setToolsExpanded"),

    // Terminal theming has no counterpart in the workbench. An empty theme object
    // keeps property reads from throwing inside extensions written for the TUI.
    theme: {},
    getAllThemes: () => { unsupported("ui.getAllThemes"); return []; },
    getTheme: () => { unsupported("ui.getTheme"); return undefined; },
    setTheme: () => { unsupported("ui.setTheme"); return { ok: false }; },
    // The remaining members are typed against pi-tui components that cannot exist
    // outside a terminal, so the shape is asserted rather than structurally matched.
  } as unknown as ExtensionUIContext;
}
