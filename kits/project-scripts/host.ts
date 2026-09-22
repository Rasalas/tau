import { isAbsolute } from "node:path";
import { HostCommandError, type HostExtension, type HostExtensionContext } from "tau/host-extension";
import { readProjectScripts } from "./project-file.js";
import {
  PROJECT_SCRIPTS_HOST_EXTENSION_ID,
  SCRIPTS_CHANGED_EVENT,
  WORKTREE_CREATED_COMMAND,
  type ProjectScriptsState,
  type ScriptScope,
  type UiScriptRun,
} from "./protocol.js";
import { ScriptRuns, spawnScript, type ScriptSpawner, type UrlProbe } from "./runner.js";
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
      const runs = new ScriptRuns({
        spawn: options.spawn ?? spawnScript,
        emit: context.emit,
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

      context.registerCommand("list", async (raw) => load(await directoryOf(scopeOf(fields(raw)))));
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
      context.registerCommand("runs", () => runs.list());

      // Workspace Kit's worktree setup, on the same script definitions. A
      // blocking script (`async: false`) holds the new thread until it exits.
      context.registerCommand(WORKTREE_CREATED_COMMAND, async (raw) => {
        const input = fields(raw);
        const project = text(input.project);
        const worktree = text(input.worktree);
        if (!project || !worktree || !isAbsolute(project) || !isAbsolute(worktree)) {
          throw new HostCommandError("worktree-created needs absolute project and worktree paths.");
        }
        const state = await readProjectScripts(project);
        const started: UiScriptRun[] = [];
        for (const script of state.scripts.filter((candidate) => candidate.runOnWorktreeCreate)) {
          const run = runs.start({
            script,
            directory: worktree,
            root: services.cwd(),
            trigger: "worktree-create",
            env: { TAU_PROJECT_ROOT: project, TAU_WORKTREE_PATH: worktree },
          });
          services.log("git.worktree.setup", `${script.id}: ${script.command}`);
          started.push(script.async ? run : await runs.finished(run.id));
        }
        for (const run of started.filter((candidate) => candidate.status === "failed")) {
          services.log("git.worktree.setup-failed", `${run.scriptId} exited with ${run.exitCode ?? run.signal ?? "?"}`);
        }
        return { runs: started };
      }, { long: true, callers: ["tau.workspace"] });

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
