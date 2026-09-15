import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { ExtensionUiAnswer, ExtensionUiPrompt, ExtensionUiPromptKind } from "../shared/contracts.js";
import { defaultUserThemeResolver } from "./user-themes.js";

export interface ExtensionUiBridge {
  /** The thread the prompt belongs to; only that thread is blocked by it. */
  sessionId(): string;
  ask(prompt: ExtensionUiPrompt): Promise<ExtensionUiAnswer>;
  notify(message: string, level: "info" | "warning" | "error"): void;
  setWindowTitle(title: string): void;
  /** Reports a capability Tau cannot render, instead of failing silently. */
  unsupported(method: string): void;
  /** Terminal surfaces; each returns false when nothing in the host draws it. */
  setStatus?(key: string, text: string | undefined): boolean;
  setWidget?(key: string, lines: string[] | undefined, placement: "aboveEditor" | "belowEditor"): boolean;
  setWorkingMessage?(message: string | undefined): boolean;
  setFooter?(lines: string[] | undefined): boolean;
  setHeader?(lines: string[] | undefined): boolean;
  setEditorText?(text: string): boolean;
  pasteToEditor?(text: string): boolean;
  getEditorText?(): string;
  setToolsExpanded?(expanded: boolean): boolean;
  getToolsExpanded?(): boolean;
  addAutocompleteProvider?(provider: (prefix: string) => Promise<unknown[]>): () => void;
  onCustomInput?(promptId: string, handler: (data: string) => void): () => void;
  updateCustomPrompt?(promptId: string, lines: string[]): boolean;
  theme?: Record<string, unknown>;
  getAllThemes?(): string[];
  getTheme?(): Record<string, unknown> | undefined;
  setTheme?(name: string): { ok: boolean };
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
    fields: Omit<ExtensionUiPrompt, "id" | "sessionId" | "kind" | "expiresAt"> & { id?: string },
    options: DialogOptions | undefined,
    read: (answer: ExtensionUiAnswer) => T,
    fallback: T,
  ): Promise<T> {
    if (options?.signal?.aborted) return fallback;
    const prompt: ExtensionUiPrompt = {
      sessionId: bridge.sessionId(),
      kind,
      ...fields,
      id: fields.id ?? promptId(),
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
    custom: async <T,>(
      factory: (
        tui: { requestRender: () => void; terminal?: { columns: number; rows: number } },
        theme: unknown,
        keybindings: unknown,
        done: (result: T) => void,
      ) => { render(width: number): string[]; handleInput?(data: string): void; invalidate?(): void },
      options?: DialogOptions,
    ): Promise<T> => {
      let resolved = false;
      let resolveResult: (val: T) => void;
      const promise = new Promise<T>((res) => {
        resolveResult = res;
      });

      const done = (result: T) => {
        if (!resolved) {
          resolved = true;
          resolveResult(result);
        }
      };

      const customPromptId = promptId();
      let component: { render(width: number): string[]; handleInput?(data: string): void; invalidate?(): void } | undefined;

      const tui = {
        requestRender: () => {
          if (component && typeof component.render === "function" && bridge.updateCustomPrompt) {
            try {
              bridge.updateCustomPrompt(customPromptId, component.render(80));
            } catch {
              // Ignore render update errors
            }
          }
        },
        terminal: { columns: 80, rows: 24 },
      };

      let cleanupInput: (() => void) | undefined;

      try {
        const theme = bridge.getTheme?.() ?? bridge.theme ?? defaultUserThemeResolver.getActiveThemeObject();
        component = typeof factory === "function" ? factory(tui, theme, {}, done) : undefined;

        if (component && typeof component.handleInput === "function" && bridge.onCustomInput) {
          cleanupInput = bridge.onCustomInput(customPromptId, (data) => {
            try {
              component?.handleInput?.(data);
            } catch {
              // Ignore input errors
            }
          });
        }

        const initialLines = typeof component?.render === "function" ? component.render(80) : [];
        const result = await ask<T>(
          "custom" as ExtensionUiPromptKind,
          {
            id: customPromptId,
            title: "Custom Dialog",
            lines: initialLines,
          },
          options,
          (answer) => {
            if ("customResult" in answer) return answer.customResult as T;
            if ("value" in answer) {
              if (component && typeof component.handleInput === "function") {
                try {
                  component.handleInput(answer.value);
                } catch {
                  // Ignore
                }
              }
              return answer.value as unknown as T;
            }
            return undefined as T;
          },
          undefined as T,
        );
        if (!resolved) {
          done(result);
        }
      } catch {
        done(undefined as T);
      } finally {
        cleanupInput?.();
      }

      return promise;
    },
    onTerminalInput: () => { unsupported("ui.onTerminalInput"); return () => {}; },
    // Text widgets, statuses and the working message go to whoever presents
    // them; component factories need a terminal and stay unsupported.
    setWidget: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
      if (typeof content === "function") { unsupported("ui.setWidget(component)"); return; }
      const lines = Array.isArray(content) ? content.map(String) : undefined;
      if (!bridge.setWidget?.(key, lines, options?.placement ?? "aboveEditor")) unsupported("ui.setWidget");
    },
    setFooter: (content: unknown) => {
      if (typeof content === "function") { unsupported("ui.setFooter(component)"); return; }
      const lines = Array.isArray(content) ? content.map(String) : undefined;
      if (!bridge.setFooter?.(lines)) unsupported("ui.setFooter");
    },
    setHeader: (content: unknown) => {
      if (typeof content === "function") { unsupported("ui.setHeader(component)"); return; }
      const lines = Array.isArray(content) ? content.map(String) : undefined;
      if (!bridge.setHeader?.(lines)) unsupported("ui.setHeader");
    },
    setStatus: (key: string, text: string | undefined) => { if (!bridge.setStatus?.(key, text)) unsupported("ui.setStatus"); },
    setWorkingMessage: (message?: string) => { if (!bridge.setWorkingMessage?.(message)) unsupported("ui.setWorkingMessage"); },
    setWorkingVisible: () => unsupported("ui.setWorkingVisible"),
    setWorkingIndicator: () => unsupported("ui.setWorkingIndicator"),
    setHiddenThinkingLabel: () => unsupported("ui.setHiddenThinkingLabel"),
    pasteToEditor: (text: string) => { if (!bridge.pasteToEditor?.(text)) unsupported("ui.pasteToEditor"); },
    setEditorText: (text: string) => { if (!bridge.setEditorText?.(text)) unsupported("ui.setEditorText"); },
    getEditorText: () => {
      const text = bridge.getEditorText?.();
      if (text === undefined) {
        unsupported("ui.getEditorText");
        return "";
      }
      return text;
    },
    addAutocompleteProvider: (provider: any) => {
      if (bridge.addAutocompleteProvider) return bridge.addAutocompleteProvider(provider);
      return () => {};
    },
    setEditorComponent: () => unsupported("ui.setEditorComponent"),
    getEditorComponent: () => { unsupported("ui.getEditorComponent"); return undefined; },
    getToolsExpanded: () => bridge.getToolsExpanded?.() ?? false,
    setToolsExpanded: (expanded: boolean) => { if (!bridge.setToolsExpanded?.(expanded)) unsupported("ui.setToolsExpanded"); },

    theme: bridge.theme ?? defaultUserThemeResolver.getActiveThemeObject(),
    getAllThemes: () => bridge.getAllThemes?.() ?? [defaultUserThemeResolver.getActiveTheme()],
    getTheme: () => bridge.getTheme?.() ?? defaultUserThemeResolver.getActiveThemeObject(),
    setTheme: (name: string) => {
      if (bridge.setTheme) return bridge.setTheme(name);
      defaultUserThemeResolver.setActiveTheme(name);
      return { ok: true };
    },
    // The remaining members are typed against pi-tui components that cannot exist
    // outside a terminal, so the shape is asserted rather than structurally matched.
  } as unknown as ExtensionUIContext;
}
