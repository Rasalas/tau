import { useEffect, useState, type ComponentType } from "react";
import { Bug, Check, Ellipsis, FlaskConical, Globe, Hammer, ListChecks, Play, Square, TriangleAlert, Wrench, X } from "lucide-react";
import { hostIsReadOnly, Menu, type RegionProps, type WorkbenchActions } from "tau";
import type { ProjectScript, ScriptIcon, ScriptScope, UiScriptRun } from "./protocol.js";
import { useProjectScripts, type ProjectScriptsStore } from "./store.js";

/** What the bar asks of the kit; the desktop entry implements it. */
export interface ScriptsController {
  store: ProjectScriptsStore;
  bind(actions: WorkbenchActions): void;
  run(scriptId: string, actions: WorkbenchActions): Promise<void>;
  stop(runId: string): void;
  dismiss(runId: string): void;
  openPreview(url: string, actions: WorkbenchActions): void;
  runInTerminal(script: ProjectScript, actions: WorkbenchActions): Promise<void>;
}

const ICONS: Record<ScriptIcon, ComponentType<{ size?: number }>> = {
  play: Play,
  test: FlaskConical,
  lint: ListChecks,
  configure: Wrench,
  build: Hammer,
  debug: Bug,
};

/** Cards shown under the bar; older runs stay on the host until dismissed or trimmed. */
const VISIBLE_RUNS = 3;
const OUTPUT_LINES = 40;

/** The checkout the workbench shows: a pending draft's project, else the thread's own. */
export function activeScope(actions: WorkbenchActions, snapshot: RegionProps["snapshot"]): ScriptScope {
  const active = actions.activeThread();
  const sessionId = active?.draftPending ? undefined : active?.sessionId ?? snapshot?.sessionId;
  const workspaceId = active?.workspaceId ?? snapshot?.workspaceId;
  return { ...(sessionId ? { sessionId } : {}), ...(workspaceId ? { workspaceId } : {}) };
}

export function createQuickActions(controller: ScriptsController): ComponentType<RegionProps> {
  return function QuickActions({ actions, snapshot }: RegionProps) {
    const view = useProjectScripts(controller.store);
    const [menuOpen, setMenuOpen] = useState(false);
    const { sessionId, workspaceId } = activeScope(actions, snapshot);
    useEffect(() => {
      controller.bind(actions);
      controller.store.follow({ ...(sessionId ? { sessionId } : {}), ...(workspaceId ? { workspaceId } : {}) });
    }, [actions, sessionId, workspaceId]);

    const state = view.state;
    const scripts = state?.scripts ?? [];
    const errors = state?.problems.filter((problem) => problem.level === "error").length ?? 0;
    const runs = state ? view.runs.filter((run) => run.directory === state.directory).slice(0, VISIBLE_RUNS) : [];
    // Every control here runs or stops something; a Read-only device gets none of them (ADR 0024).
    if (hostIsReadOnly() || (!view.error && scripts.length === 0 && errors === 0 && runs.length === 0)) return null;
    const running = new Set(runs.filter((run) => run.status === "running").map((run) => run.scriptId));

    return (
      <div className="project-scripts">
        <div className="project-scripts-bar" role="toolbar" aria-label="Project scripts">
          {scripts.map((script) => {
            const Icon = ICONS[script.icon];
            return (
              <button
                key={script.id}
                className="chip project-script"
                data-script-id={script.id}
                aria-label={`Run ${script.name}`}
                title={`${script.command}${script.keybinding ? ` (${script.keybinding})` : ""}`}
                onClick={() => { void controller.run(script.id, actions); }}
              >
                {running.has(script.id) ? <span className="spinner small" /> : <Icon size={12} />}
                <span>{script.name}</span>
              </button>
            );
          })}
          {errors > 0 ? (
            <button className="chip project-scripts-problem" title={state?.file} onClick={() => actions.openSettings("inspector")}>
              <TriangleAlert size={12} />
              <span>{errors === 1 ? "1 problem" : `${errors} problems`} in .tau/project.json</span>
            </button>
          ) : null}
          {view.error ? <span className="project-scripts-note">{view.error}</span> : null}
          {state ? (
            <span className="menu-anchor project-scripts-more">
              <button className="icon-button" aria-label="More script actions" onClick={() => setMenuOpen((open) => !open)}>
                <Ellipsis size={13} />
              </button>
              {menuOpen ? (
                <Menu
                  placement="above"
                  align="right"
                  sections={[
                    ...(scripts.length > 0 ? [{ heading: "Run in a terminal", items: scripts.map((script) => ({ id: `terminal:${script.id}`, label: script.name, hint: script.command })) }] : []),
                    { items: [
                      ...(state.exists ? [{ id: "open-file", label: "Open .tau/project.json" }] : []),
                      { id: "reload", label: "Read the file again" },
                    ] },
                  ]}
                  onSelect={(id) => {
                    setMenuOpen(false);
                    if (id === "open-file") actions.openFile(".tau/project.json", { pin: true });
                    else if (id === "reload") void controller.store.refresh();
                    else if (id.startsWith("terminal:")) {
                      const script = scripts.find((candidate) => `terminal:${candidate.id}` === id);
                      if (script) void controller.runInTerminal(script, actions);
                    }
                  }}
                  onClose={() => setMenuOpen(false)}
                />
              ) : null}
            </span>
          ) : null}
        </div>
        {runs.map((run) => <RunCard key={run.id} run={run} controller={controller} actions={actions} />)}
      </div>
    );
  };
}

function RunCard({ run, controller, actions }: { run: UiScriptRun; controller: ScriptsController; actions: WorkbenchActions }) {
  const [open, setOpen] = useState(run.status === "failed");
  useEffect(() => { if (run.status === "failed") setOpen(true); }, [run.status]);
  const Icon = ICONS[run.icon];
  const lines = run.output.replace(/\n$/u, "").split("\n");
  const tail = lines.slice(-OUTPUT_LINES).join("\n");
  return (
    <div className="project-script-run" data-status={run.status} data-run-id={run.id}>
      <div className="project-script-run-head">
        <button className="project-script-run-title" aria-expanded={open} onClick={() => setOpen((current) => !current)}>
          <Icon size={12} />
          <span>{run.name}</span>
          {run.trigger === "worktree-create" ? <span className="project-script-run-tag">setup</span> : null}
        </button>
        <span className="project-script-run-status">{statusLabel(run)}</span>
        {run.previewUrl ? (
          <button className="mini-button" aria-label={`Open preview for ${run.name}`} title={run.previewUrl} onClick={() => controller.openPreview(run.previewUrl!, actions)}>
            <Globe size={12} />
          </button>
        ) : null}
        {run.status === "running" ? (
          <button className="mini-button" aria-label={`Stop ${run.name}`} onClick={() => controller.stop(run.id)}><Square size={11} /></button>
        ) : (
          <button className="mini-button" aria-label={`Dismiss ${run.name}`} onClick={() => controller.dismiss(run.id)}><X size={12} /></button>
        )}
      </div>
      {open ? (
        <pre className="project-script-run-output" aria-label={`${run.name} output`}>
          {run.outputLength > run.output.length || lines.length > OUTPUT_LINES ? "…\n" : ""}
          {tail || (run.status === "running" ? "No output yet." : "No output.")}
        </pre>
      ) : null}
    </div>
  );
}

function statusLabel(run: UiScriptRun) {
  if (run.status === "running") return <><span className="spinner small" /> running</>;
  if (run.status === "succeeded") return <><Check size={12} /> exit 0 · {duration(run)}</>;
  if (run.status === "stopped") return <>stopped · {duration(run)}</>;
  return <><TriangleAlert size={12} /> {run.exitCode === undefined ? run.signal ?? "failed" : `exit ${run.exitCode}`} · {duration(run)}</>;
}

function duration(run: UiScriptRun): string {
  const seconds = Math.max(0, Math.round(((run.endedAt ?? run.startedAt) - run.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
