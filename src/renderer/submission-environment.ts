import type { HostClient } from "../workbench/host-client";
import type { SubmissionEnvironment } from "../workbench/submission-controller";
import type { ExtensionRegistry, WorkbenchActions } from "./extension-system";
import type { PreferencesStore } from "./preferences";
import { chosenNewThreadRuntime, effectiveNewThreadRuntime } from "./new-thread-runtime";
import { runtimeCatalogStore } from "./use-runtime-catalog";
import { errorMessage } from "../workbench/error-message";

/** Binds renderer contributions without exposing the workbench's state graph. */
export function submissionEnvironment(options: {
  client(): HostClient | undefined;
  registry: ExtensionRegistry;
  preferences: PreferencesStore;
  actions(): WorkbenchActions | undefined;
  notify(message?: string, level?: "info" | "warning" | "error"): void;
}): SubmissionEnvironment {
  const { registry, preferences } = options;
  return {
    command: (text) => {
      const slash = registry.findSlashCommand(text);
      const excluded = text.startsWith("!!");
      const shell = text.startsWith("!") ? text.slice(excluded ? 2 : 1).trim() : "";
      if (!slash && !shell) return undefined;
      return async () => {
        const actions = options.actions();
        if (!actions) return { accepted: false, message: "The workbench is not ready yet." };
        try {
          if (slash) {
            const message = await slash.command.run(slash.args, actions);
            return message ? { accepted: false, message } : { accepted: true };
          }
          const result = await actions.runShellAction(shell, !excluded);
          if (result.cancelled) options.notify("Shell command cancelled.");
          else if (result.exitCode !== undefined && result.exitCode !== 0) options.notify(`Shell command exited with code ${result.exitCode}`);
          return { accepted: true };
        } catch (error) {
          return { accepted: false, message: errorMessage(error) };
        }
      };
    },
    claimNewThread: async (event) => {
      const actions = options.actions();
      return actions ? registry.claimNewThread(event, actions) : false;
    },
    prepareNewThread: async (event) => {
      const actions = options.actions();
      return actions ? registry.prepareNewThread(event, actions) : undefined;
    },
    accepted: () => registry.dispatchWorkbenchEvent({ type: "prompt-accepted" }),
    submitted: async (event) => {
      const actions = options.actions();
      if (actions) await registry.notifyPromptSubmitted(event, actions);
    },
    selection: (pending, snapshot) => {
      const preference = pending.runtime ?? preferences.getSnapshot().newThreadRuntime;
      const catalogs = runtimeCatalogStore(options.client())?.all();
      const runtime = effectiveNewThreadRuntime(preference, snapshot, catalogs);
      const requestedRuntime = chosenNewThreadRuntime(preference, snapshot, catalogs);
      const inherited = runtime === "pi" && (snapshot?.backendKind ?? "pi") === "pi" ? snapshot?.model : undefined;
      const chosen = (pending.selectionRuntime ?? "pi") === runtime;
      const model = (chosen ? pending.model : undefined) ?? inherited;
      const thinkingLevel = chosen ? pending.thinkingLevel : undefined;
      const backend = snapshot?.runtimeBackends?.find((entry) => entry.kind === runtime);
      const mode = pending.mode && (!backend || backend.modes?.includes(pending.mode)) ? pending.mode : undefined;
      return { runtime, requestedRuntime, model, ...(thinkingLevel ? { thinkingLevel } : {}), ...(mode ? { mode } : {}) };
    },
    unsettle: (sessionId) => preferences.unsettle(sessionId),
    preview: (reply) => { window.setTimeout(reply, 650); },
  };
}
