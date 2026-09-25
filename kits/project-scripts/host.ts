import { isAbsolute } from "node:path";
import { HostCommandError, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { readProjectScripts } from "./project-file.js";
import {
  PROJECT_SCRIPTS_HOST_EXTENSION_ID,
  RUN_EVENT,
  SCRIPTS_CHANGED_EVENT,
  SETUP_DISMISSED_EVENT,
  SETUP_EVENT,
  WORKTREE_CREATED_COMMAND,
  WORKTREE_SETUP_BEGIN_COMMAND,
  WORKTREE_SETUP_FAILED_COMMAND,
  WORKTREE_SETUP_STEP_COMMAND,
  type ProjectScriptsState,
  type ScriptScope,
  type UiScriptRun,
} from "./protocol.js";
import { ScriptRuns, spawnScript, type ScriptSpawner, type UrlProbe } from "./runner.js";
import { GIT_STAGES, SetupTracker, type SetupGitStage } from "./setup.js";
import { ProjectFileWatch, type WatchFn } from "./watch.js";

export interface ProjectScriptsHostOptions {
  spawn?: ScriptSpawner;
  probe?: UrlProbe;
  /** `false` watches nothing; a test passes its own. */
  watch?: WatchFn | false;
  debounceMs?: number;
}

// IPC input is untrusted; every command re-reads its fields.
const fields = (input: unknown): Record<string, unknown> =>
  input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" && value ? value : undefined;

/** What a client needs to redraw; a save that changed nothing of it pushes nothing. */
const fingerprint = (state: ProjectScriptsState) => JSON.stringify([state.exists, state.scripts, state.problems]);

/**
 * Project Scripts' host entry: reads `.tau/project.json` for a checkout, runs
 * its scripts there as jobs whose output and exit code are pushed to the
 * client, runs the worktree setup Workspace Kit asks for, and follows the file
 * while a client looks at it.
 */
export function createProjectScriptsHostExtension(options: ProjectScriptsHostOptions = {}): HostExtension {
  return {
    id: PROJECT_SCRIPTS_HOST_EXTENSION_ID,
    name: "Project Scripts",
    permissions: ["workspace:read", "sessions", "process", "network"],
    activate(context: HostExtensionContext) {
      const { services } = context;
      const setups = new SetupTracker({ emit: (setup) => context.emit(SETUP_EVENT, setup) });
      const runs = new ScriptRuns({
        spawn: options.spawn ?? spawnScript,
        emit: (name, payload) => {
          context.emit(name, payload);
          if (name === RUN_EVENT) setups.runChanged(payload as UiScriptRun);
        },
        ...(options.probe ? { probe: options.probe } : {}),
        onSpawn: () => services.noteSubprocess(),
      });
      const seen = new Map<string, string>();
      // TAU_NO_WATCH=1 is core's switch for headless and CI runs; this kit honours it too.
      const watchEnabled = options.watch === undefined ? process.env.TAU_NO_WATCH !== "1" : options.watch !== false;
      const watch = watchEnabled
        ? new ProjectFileWatch({
          ...(options.watch ? { watch: options.watch } : {}),
          ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
          onChange: (directory) => {
            void readProjectScripts(directory).then((state) => {
              const next = fingerprint(state);
              if (seen.get(directory) === next) return;
              seen.set(directory, next);
              context.emit(SCRIPTS_CHANGED_EVENT, { directory });
            }).catch((error: unknown) => services.log("project-scripts.watch-failed", error instanceof Error ? error.message : String(error)));
          },
        })
        : undefined;

      /** The thread's own checkout first: a worktree thread runs its scripts in its worktree. */
      const directoryOf = async (scope: ScriptScope): Promise<string> => {
        const thread = scope.sessionId ? services.thread(scope.sessionId) : undefined;
        if (thread) return thread.cwd;
        if (scope.workspaceId) return services.knownWorkspacePath(scope.workspaceId);
        return services.cwd();
      };
      const scopeOf = (input: Record<string, unknown>): ScriptScope => ({
        ...(text(input.sessionId) ? { sessionId: text(input.sessionId) } : {}),
        ...(text(input.workspaceId) ? { workspaceId: text(input.workspaceId) } : {}),
      });
      const load = async (directory: string): Promise<ProjectScriptsState> => {
        const state = await readProjectScripts(directory);
        seen.set(directory, fingerprint(state));
        watch?.follow(directory);
        return state;
      };

      context.registerCommand("list", async (raw) => load(await directoryOf(scopeOf(fields(raw)))), { access: "read" });
      context.registerCommand("run", async (raw) => {
        const input = fields(raw);
        const scriptId = text(input.scriptId);
        if (!scriptId) throw new HostCommandError('Project Scripts needs "scriptId".');
        const scope = scopeOf(input);
        const directory = await directoryOf(scope);
        const state = await load(directory);
        const script = state.scripts.find((candidate) => candidate.id === scriptId);
        if (!script) throw new HostCommandError(`No script "${scriptId}" in ${state.file}.`);
        const running = runs.running(script.id, directory);
        if (running) return { run: running, started: false };
        const run = runs.start({
          script,
          directory,
          root: services.cwd(),
          ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
          trigger: "user",
          env: { TAU_PROJECT_ROOT: directory },
        });
        services.log("project-scripts.run", `${script.id} in ${directory}`);
        return { run, started: true };
      });
      context.registerCommand("stop", (raw) => { runs.stop(String(fields(raw).runId)); });
      context.registerCommand("dismiss", (raw) => { runs.dismiss(String(fields(raw).runId)); });
      context.registerCommand("runs", () => runs.list(), { access: "read" });

      // Workspace Kit's worktree setup, on the same script definitions, tracked
      // step by step for the card. A blocking script (`async: false`) holds the
      // new thread until it exits, the user cancels it or stops waiting.
      const workspaceOnly = { callers: ["tau.workspace"] };
      const setupIdOf = (input: Record<string, unknown>) => {
        const id = text(input.setupId);
        return id && setups.get(id) ? id : undefined;
      };
      context.registerCommand(WORKTREE_SETUP_BEGIN_COMMAND, async (raw) => {
        const input = fields(raw);
        const project = text(input.project);
        if (!project || !isAbsolute(project)) throw new HostCommandError("worktree-setup-begin needs an absolute project path.");
        const state = await readProjectScripts(project);
        const setup = setups.begin({
          project,
          ...(text(input.branch) ? { branch: text(input.branch) } : {}),
          scripts: state.scripts.filter((script) => script.runOnWorktreeCreate),
        });
        return { setupId: setup.id };
      }, workspaceOnly);
      context.registerCommand(WORKTREE_SETUP_STEP_COMMAND, (raw) => {
        const input = fields(raw);
        const id = setupIdOf(input);
        if (id && GIT_STAGES.includes(input.stage as SetupGitStage)) setups.step(id, input.stage as SetupGitStage, text(input.detail), input.failed === true);
      }, workspaceOnly);
      context.registerCommand(WORKTREE_SETUP_FAILED_COMMAND, (raw) => {
        const input = fields(raw);
        const id = setupIdOf(input);
        if (id) setups.failed(id, text(input.error) ?? "The worktree could not be created.");
      }, workspaceOnly);
      // Remote Work Kit sets up the worktree it makes for another machine's transfer the same way.
      context.registerCommand(WORKTREE_CREATED_COMMAND, async (raw) => {
        const input = fields(raw);
        const project = text(input.project);
        const worktree = text(input.worktree);
        if (!project || !worktree || !isAbsolute(project) || !isAbsolute(worktree)) {
          throw new HostCommandError("worktree-created needs absolute project and worktree paths.");
        }
        const state = await readProjectScripts(project);
        const scripts = state.scripts.filter((candidate) => candidate.runOnWorktreeCreate);
        const setupId = setupIdOf(input) ?? setups.begin({ project, scripts }).id;
        setups.created(setupId, worktree);
        const started: UiScriptRun[] = [];
        const endings = new Map<string, Promise<UiScriptRun>>();
        const ended = (run: UiScriptRun) => {
          let ending = endings.get(run.id);
          if (!ending) {
            ending = runs.finished(run.id).catch(() => run).then((final) => {
              if (final.status === "failed") services.log("git.worktree.setup-failed", `${final.scriptId} exited with ${final.exitCode ?? final.signal ?? "?"}`);
              return final;
            });
            endings.set(run.id, ending);
          }
          return ending;
        };
        const blocking = (async () => {
          for (const script of scripts) {
            if (setups.isCancelled(setupId)) break;
            const run = runs.start({
              script,
              directory: worktree,
              root: services.cwd(),
              trigger: "worktree-create",
              env: { TAU_PROJECT_ROOT: project, TAU_WORKTREE_PATH: worktree },
            });
            services.log("git.worktree.setup", `${script.id}: ${script.command}`);
            started.push(run);
            setups.attach(setupId, script.id, run);
            const ending = ended(run);
            if (!script.async) await ending;
          }
        })();
        void blocking.then(() => Promise.all(started.map(ended))).finally(() => setups.finish(setupId));
        await Promise.race([blocking, setups.released(setupId)]);
        const current = new Map(runs.list().map((run) => [run.id, run]));
        return { setupId, runs: started.map((run) => current.get(run.id) ?? run) };
      }, { long: true, callers: ["tau.workspace", "tau.remote-work"] });

      context.registerCommand("setups", () => setups.list(), { access: "read" });
      context.registerCommand("setup-cancel", (raw) => {
        const id = setupIdOf(fields(raw));
        if (!id) return;
        for (const runId of setups.cancel(id)) runs.stop(runId);
        services.log("git.worktree.setup-cancelled", id);
      });
      context.registerCommand("setup-release", (raw) => {
        const id = setupIdOf(fields(raw));
        if (id) setups.release(id);
      });
      context.registerCommand("setup-dismiss", (raw) => {
        const id = setupIdOf(fields(raw));
        if (id && setups.dismiss(id)) context.emit(SETUP_DISMISSED_EVENT, { id });
      });

      // A script belongs to the workspace it was started from and ends with it.
      const unhook = services.registerThreadLifecycle({
        afterWorkspaceClose: async (cwd, reason) => {
          const stopped = runs.stopWorkspace(cwd);
          if (stopped > 0) services.log("project-scripts.workspace-closed", `${stopped} script(s) stopped with ${cwd} (${reason})`);
        },
      });
      return () => {
        unhook();
        watch?.dispose();
        runs.dispose();
      };
    },
  };
}

export default createProjectScriptsHostExtension;
