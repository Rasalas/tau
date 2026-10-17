import type { SlashCommandContribution, WorkbenchActions } from "../extension-system";
import { errorMessage } from "../../workbench/error-message";
import { goalCommandRefusal, shownGoal } from "../goal-state";
export { modelItems, runtimeItems, themeItems } from "./palette-menus";

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

const EFFORT_CHIP = '[data-composer-shortcut~="composer.effort"]';

/**
 * The composer's thinking menu for the thread on screen, the way ⌘⇧E opens it.
 * Without a composer (Settings open, no thread) the default Pi starts on is
 * what there is to set.
 */
function openThinking(app: WorkbenchActions) {
  const chip = document.querySelector<HTMLButtonElement>(EFFORT_CHIP);
  if (!chip) app.openSettings("runtimes/pi#setting-default-thinking");
  else if (chip.disabled) app.notify("This thread's runtime sets its reasoning itself.");
  else chip.click();
}

async function copyChat(app: WorkbenchActions, done: string, missing: string): Promise<string | undefined> {
  if (!app.copyChat) return missing;
  await app.copyChat();
  app.notify(done);
  return undefined;
}

/**
 * `/goal <objective>` sets the thread's native goal; `pause`, `resume` and
 * `end` act on it, and `/goal` alone says where it stands. Answers a line
 * when it could not act.
 */
async function runGoalCommand(args: string, app: WorkbenchActions): Promise<string | void> {
  if (!app.threadGoal) return "This Tau has no goals.";
  const current = shownGoal();
  if (!current?.supported) return "This thread's runtime keeps no goals. Codex and Claude Code threads do.";
  const word = args.trim();
  const command = word.toLowerCase();
  try {
    if (!word) {
      const goal = current.goal;
      app.notify(goal ? `Goal (${goal.status}): ${goal.objective}` : "No goal is set. Use /goal <objective>.");
    } else if (command === "pause" || command === "resume") {
      const refusal = goalCommandRefusal(command);
      if (refusal) return refusal;
      await app.threadGoal(command);
    } else if (command === "end" || command === "clear") {
      const refusal = goalCommandRefusal("end");
      if (refusal) return refusal;
      await app.threadGoal("clear");
    } else await app.threadGoal("set", word);
  } catch (error) {
    return errorMessage(error);
  }
}

export const slashRuns: Record<string, SlashRun> = {
  goal: runGoalCommand,
  reload: async (_args, app) => (await app.reloadWorkbench()) ? undefined : "Tau reload failed.",
  source: async (_args, app) => (await app.openWorkbenchSource()) ? undefined : "Tau source could not be opened.",
  tree: (_args, app) => app.openThreadTree("navigate"),
  fork: (_args, app) => app.openThreadTree("fork"),
  clone: async (_args, app) => (await app.duplicateThread()) ? undefined : "The thread could not be duplicated.",
  compact: async (_args, app) => {
    if (!app.compactContext) return "Context compaction is not available.";
    // The transcript marks the compaction; a failure arrives as a notice.
    await app.compactContext();
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
    openThinking(app);
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
  },
  "runtime.thinking": openThinking,
  "composer.effort": (app) => {
    const control = document.querySelector<HTMLButtonElement>(EFFORT_CHIP);
    if (control && !control.disabled) control.click();
    else app.notify("This thread's runtime sets its reasoning itself.");
  },
  "runtime.copy-chat": async (app) => { await copyChat(app, "Chat copied as Markdown.", ""); },
};
