import { errorMessage, type DesktopExtension, type ExtensionProblem, type WorkbenchActions } from "tau";
import { activeScope, createQuickActions, type ScriptsController } from "./bar.js";
import {
  PREVIEW_BROWSER_SERVICE,
  PROJECT_SCRIPTS_HOST_EXTENSION_ID,
  RUN_DISMISSED_EVENT,
  RUN_EVENT,
  SCRIPTS_CHANGED_EVENT,
  TERMINAL_HOST_EXTENSION_ID,
  TERMINAL_PANEL,
  createProjectScriptsHostClient,
  scriptCommandId,
  type PreviewBrowserService,
  type ProjectScript,
  type ProjectScriptsState,
  type UiScriptRun,
} from "./protocol.js";
import { ProjectScriptsStore } from "./store.js";

const isRun = (value: unknown): value is UiScriptRun =>
  Boolean(value && typeof (value as UiScriptRun).id === "string" && typeof (value as UiScriptRun).status === "string");
const directoryOf = (value: unknown): string | undefined => {
  const directory = (value as { directory?: unknown } | null)?.directory;
  return typeof directory === "string" ? directory : undefined;
};

/** Commands and chords are re-registered only when what they say changed. */
const commandKey = (scripts: readonly ProjectScript[]) => JSON.stringify(scripts.map((script) => [script.id, script.name, script.keybinding]));

/**
 * Project Scripts: the scripts a repository checks in with `.tau/project.json`
 * as a bar above the composer, one `script.<id>.run` command per script with
 * its chord, run cards with exit code and output, and the preview opened once
 * the script's `previewUrl` answers.
 */
export const projectScriptsExtension: DesktopExtension = {
  id: PROJECT_SCRIPTS_HOST_EXTENSION_ID,
  name: "Project Scripts",
  activate(plugin) {
    const host = createProjectScriptsHostClient((command, input) => plugin.host.invoke(command, input));
    const store = new ProjectScriptsStore(host);
    let actions: WorkbenchActions | undefined;
    let browser: PreviewBrowserService | undefined;
    /** Runs this window started, and runs whose preview it already opened. */
    const startedHere = new Set<string>();
    const previewed = new Set<string>();

    const openPreview = (url: string, app: WorkbenchActions) => {
      if (!browser) {
        app.openExternal(url);
        return;
      }
      browser.open(url, app).catch((error: unknown) => app.notify(`Could not open the preview: ${errorMessage(error)}`));
    };

    const controller: ScriptsController = {
      store,
      bind: (next) => { actions = next; },
      run: async (scriptId, app) => {
        actions = app;
        const active = activeScope(app, undefined);
        const scope = active.sessionId || active.workspaceId ? active : store.currentScope() ?? {};
        try {
          const { run, started } = await host.run({ ...scope, scriptId });
          startedHere.add(run.id);
          store.applyRun(run);
          if (!started) {
            app.notify(`${run.name} is already running.`);
            if (run.previewUrl && run.previewReady) openPreview(run.previewUrl, app);
          }
        } catch (error) {
          app.notify(errorMessage(error));
        }
      },
      stop: (runId) => { host.stop({ runId }).catch((error: unknown) => actions?.notify(errorMessage(error))); },
      dismiss: (runId) => {
        store.removeRun(runId);
        host.dismiss({ runId }).catch((error: unknown) => actions?.notify(errorMessage(error)));
      },
      openPreview,
      // Terminal Kit's own commands, reached by id: a shell in the same
      // checkout, with the script typed into it.
      runInTerminal: async (script, app) => {
        const scope = activeScope(app, undefined);
        const terminal = plugin.hostExtension(TERMINAL_HOST_EXTENSION_ID);
        try {
          const session = await terminal.invoke("open", { ...scope, label: script.name }) as { id: string };
          await terminal.invoke("input", { id: session.id, data: `${script.command}\r` });
          app.openPanel(TERMINAL_PANEL);
        } catch (error) {
          app.notify(`Could not run ${script.name} in a terminal: ${errorMessage(error)}`);
        }
      },
    };

    const followRun = (run: UiScriptRun) => {
      const previous = store.applyRun(run);
      const onScreen = store.getSnapshot().state?.directory === run.directory;
      if (run.previewUrl && run.previewReady && run.autoOpenPreview && run.status === "running" && !previewed.has(run.id) && (startedHere.has(run.id) || onScreen)) {
        previewed.add(run.id);
        if (actions) openPreview(run.previewUrl, actions);
      }
      const ended = run.status !== "running" && (previous?.status === "running" || (!previous && startedHere.has(run.id)));
      if (ended && run.status === "failed" && (startedHere.has(run.id) || onScreen)) {
        actions?.notify(`${run.name} exited with ${run.exitCode ?? run.signal ?? "an error"}.`);
      }
    };

    const offRun = plugin.host.onEvent(RUN_EVENT, (payload) => { if (isRun(payload)) followRun(payload); });
    const offDismissed = plugin.host.onEvent(RUN_DISMISSED_EVENT, (payload) => {
      const id = (payload as { id?: unknown } | null)?.id;
      if (typeof id === "string") store.removeRun(id);
    });
    const offChanged = plugin.host.onEvent(SCRIPTS_CHANGED_EVENT, (payload) => {
      const directory = directoryOf(payload);
      if (directory) store.scriptsChanged(directory);
    });
    const offService = plugin.useService<PreviewBrowserService>(PREVIEW_BROWSER_SERVICE, (value) => {
      browser = value;
      return () => { if (browser === value) browser = undefined; };
    });

    // One command per script of the checkout on screen, and its chord.
    let registered: { key: string; dispose: () => void } | undefined;
    let keybindingProblems: ExtensionProblem[] = [];
    const sync = (state: ProjectScriptsState | undefined) => {
      const scripts = state?.scripts ?? [];
      const key = commandKey(scripts);
      if (registered?.key !== key) {
        registered?.dispose();
        keybindingProblems = [];
        const disposers: Array<() => void> = [];
        for (const script of scripts) {
          const commandId = scriptCommandId(script.id);
          disposers.push(plugin.registerCommand({ id: commandId, label: `Run ${script.name}`, group: "Project", run: (app) => controller.run(script.id, app) }));
          if (!script.keybinding) continue;
          try {
            disposers.push(plugin.registerKeybinding({ keys: script.keybinding, commandId }));
          } catch (error) {
            keybindingProblems.push({ source: state?.file ?? "", message: `"${script.name}": ${errorMessage(error)}`, level: "warning" });
          }
        }
        registered = { key, dispose: () => { for (const dispose of disposers.reverse()) dispose(); } };
      }
      plugin.setProblems([...(state?.problems ?? []).map(({ source, message, level }) => ({ source, message, level })), ...keybindingProblems]);
    };
    let lastState: ProjectScriptsState | undefined;
    const offStore = store.subscribe(() => {
      const state = store.getSnapshot().state;
      if (state === lastState) return;
      lastState = state;
      sync(state);
    });

    const region = plugin.registerRegion({ id: "project-scripts.bar", placement: "composer-above", order: 40, profiles: ["desktop", "web"], Component: createQuickActions(controller) });
    const reload = plugin.registerCommand({ id: "project-scripts.reload", label: "Read .tau/project.json again", group: "Project", run: () => store.refresh() });
    void store.loadRuns();

    return () => {
      reload();
      region();
      offStore();
      registered?.dispose();
      registered = undefined;
      offService();
      offChanged();
      offDismissed();
      offRun();
    };
  },
};

export default projectScriptsExtension;
