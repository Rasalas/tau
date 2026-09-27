import type { SlashCommandContribution, WorkbenchActions } from "../extension-system";

/**
 * What core's slash commands and its wordier commands do. Loaded on their
 * first use, so the start-up script carries only their names (`runtime-controls`).
 */

type SlashRun = SlashCommandContribution["run"];

const THINKING_LEVELS = ["none", "low", "medium", "high", "max"];

const openModelPicker = (app: WorkbenchActions) => {
  if (app.openModelPicker) app.openModelPicker();
  else app.openSettings("models#setting-default-model");
};

async function copyChat(app: WorkbenchActions, done: string, missing: string): Promise<string | undefined> {
  if (!app.copyChat) return missing;
  await app.copyChat();
  app.notify(done);
  return undefined;
}

export const slashRuns: Record<string, SlashRun> = {
  reload: async (_args, app) => (await app.reloadWorkbench()) ? undefined : "Tau reload failed.",
  source: async (_args, app) => (await app.openWorkbenchSource()) ? undefined : "Tau source could not be opened.",
  tree: (_args, app) => app.openThreadTree("navigate"),
  fork: (_args, app) => app.openThreadTree("fork"),
  clone: async (_args, app) => (await app.duplicateThread()) ? undefined : "The thread could not be duplicated.",
  compact: async (_args, app) => {
    if (!app.compactContext) return "Context compaction is not available.";
    await app.compactContext();
    app.notify("Context compacted.");
    return undefined;
  },
  model: async (args, app) => {
    const query = args.trim();
    if (query && app.setModel) {
      if (await app.setModel(query)) app.notify(`Model switched to ${query}.`);
      else app.notify(`No model matches “${query}”.`);
      return undefined;
    }
    openModelPicker(app);
    return undefined;
  },
  thinking: async (args, app) => {
    const level = args.trim().toLowerCase();
    if (level && !THINKING_LEVELS.includes(level)) {
      app.notify(`Invalid thinking level: “${level}”. Valid: ${THINKING_LEVELS.join(", ")}.`);
      return undefined;
    }
    if (level && app.setThinkingLevel) {
      await app.setThinkingLevel(level);
      app.notify(`Thinking level set to ${level}.`);
      return undefined;
    }
    app.openSettings("models#setting-thinking-level");
    return undefined;
  },
  new: (_args, app) => { app.newSession(); },
  clear: (_args, app) => { app.newSession(); },
  system: (_args, app) => { app.openInstructions?.(); },
  instructions: (_args, app) => { app.openInstructions?.(); },
  copy: (_args, app) => copyChat(app, "Chat copied as Markdown.", "Copy chat is not available."),
  export: (_args, app) => copyChat(app, "Exported chat to clipboard as Markdown.", "Export is not available."),
  session: (_args, app) => {
    const thread = app.activeThread();
    if (!thread) return "No active session.";
    const modelStr = thread.model ? `${thread.model.provider}/${thread.model.id}` : "default";
    app.notify(`Session: ${thread.sessionId ?? "new"} · Backend: ${thread.backendKind ?? "pi"} · Model: ${modelStr}`);
    return undefined;
  },
  help: (_args, app) => { app.openCommandPalette(); },
  name: async (args, app) => {
    const title = args.trim();
    if (!title) return "Usage: /name <title>";
    if (app.renameThread && await app.renameThread(title)) {
      app.notify(`Thread renamed to “${title}”.`);
      return undefined;
    }
    return "Could not rename thread.";
  },
  hotkeys: (_args, app) => { app.openSettings("keybindings"); },
  "scoped-models": (_args, app) => { openModelPicker(app); },
};

export const commandRuns: Record<string, (app: WorkbenchActions) => void | Promise<void>> = {
  "runtime.compact": async (app) => {
    if (!app.compactContext) return;
    await app.compactContext();
    app.notify("Context compacted.");
  },
  "composer.effort": (app) => {
    const control = document.querySelector<HTMLButtonElement>('[data-composer-shortcut~="composer.effort"]');
    if (control && !control.disabled) control.click();
    else app.notify("This thread's runtime sets its reasoning itself.");
  },
  "runtime.copy-chat": async (app) => { await copyChat(app, "Chat copied as Markdown.", ""); },
  "runtime.rename-thread": async (app) => {
    const currentTitle = app.activeThread()?.sessionId ?? "";
    const next = window.prompt("New thread title:", currentTitle)?.trim();
    if (next && app.renameThread) {
      await app.renameThread(next);
      app.notify(`Thread renamed to “${next}”.`);
    }
  },
};
