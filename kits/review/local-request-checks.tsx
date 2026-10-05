import { useCallback, useEffect, useState } from "react";
import { CircleCheck, CircleDashed, CircleX, LoaderCircle, Play, Square } from "lucide-react";
import { errorMessage, READ_ONLY_REASON, tooltipProps, useCommandAllowed, type HostExtensionClient } from "tau";
import { relativeTime } from "./pull-request-logic.js";

/** Project Scripts' contract, mirrored rather than imported: the part the local checks read. */
export const PROJECT_SCRIPTS_EXTENSION_ID = "tau.project-scripts";

interface Script { id: string; name: string; command: string }
interface ScriptsState { directory: string; exists: boolean; scripts: Script[] }
interface ScriptRun { id: string; scriptId: string; directory: string; status: "running" | "succeeded" | "failed" | "stopped"; exitCode?: number; startedAt: number; endedAt?: number }
export interface ScriptScope { sessionId?: string; workspaceId?: string }

const isRun = (value: unknown): value is ScriptRun => Boolean(value && typeof (value as ScriptRun).id === "string" && typeof (value as ScriptRun).scriptId === "string");

/** The newest run of each script in the directory. */
function latestRuns(runs: readonly ScriptRun[], directory: string): Map<string, ScriptRun> {
  const latest = new Map<string, ScriptRun>();
  for (const run of runs) {
    if (run.directory !== directory) continue;
    const held = latest.get(run.scriptId);
    if (!held || held.startedAt <= run.startedAt) latest.set(run.scriptId, run);
  }
  return latest;
}

function RunState({ run }: { run: ScriptRun | undefined }) {
  if (!run) return <span className="lpr-check-state"><CircleDashed size={13} aria-hidden="true" /> Not run</span>;
  const when = relativeTime(new Date(run.endedAt ?? run.startedAt).toISOString());
  if (run.status === "running") return <span className="lpr-check-state pending"><LoaderCircle size={13} className="lpr-spin" aria-hidden="true" /> Running</span>;
  if (run.status === "succeeded") return <span className="lpr-check-state passed"><CircleCheck size={13} aria-hidden="true" /> Passed · {when}</span>;
  if (run.status === "stopped") return <span className="lpr-check-state"><CircleDashed size={13} aria-hidden="true" /> Stopped · {when}</span>;
  return <span className="lpr-check-state failed"><CircleX size={13} aria-hidden="true" /> Failed{run.exitCode === undefined ? "" : ` (exit ${run.exitCode})`} · {when}</span>;
}

/**
 * The branch's checks before there is CI to run them: the project's own
 * scripts (`.tau/project.json`) with the last run of each in this checkout,
 * run or stopped from here through Project Scripts.
 */
export function LocalChecks({ scripts, scope }: { scripts: HostExtensionClient; scope: ScriptScope | undefined }) {
  const [state, setState] = useState<ScriptsState>();
  const [runs, setRuns] = useState<ScriptRun[]>([]);
  const [error, setError] = useState<string>();
  const mayRun = useCommandAllowed(PROJECT_SCRIPTS_EXTENSION_ID, "run");
  const mayStop = useCommandAllowed(PROJECT_SCRIPTS_EXTENSION_ID, "stop");

  const load = useCallback(async () => {
    if (!scope) return;
    try {
      const [next, all] = await Promise.all([scripts.invoke("list", scope) as Promise<ScriptsState>, scripts.invoke("runs") as Promise<ScriptRun[]>]);
      setState(next);
      setRuns(all);
      setError(undefined);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }, [scope?.sessionId, scope?.workspaceId, scripts]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void load();
    const off = scripts.onEvent("run", (payload) => {
      if (isRun(payload)) setRuns((current) => [...current.filter((run) => run.id !== payload.id), payload]);
    });
    const offChanged = scripts.onEvent("scripts-changed", () => { void load(); });
    return () => { off(); offChanged(); };
  }, [load, scripts]);

  const start = async (script: Script) => {
    try {
      const answer = await scripts.invoke("run", { ...scope, scriptId: script.id }) as { run: ScriptRun };
      if (isRun(answer.run)) setRuns((current) => [...current.filter((run) => run.id !== answer.run.id), answer.run]);
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  if (error && !state) return <p className="pr-empty">Project Scripts could not list the checks: {error}</p>;
  if (!state) return <p className="pr-empty" role="status">Reading the project's scripts…</p>;
  if (state.scripts.length === 0) {
    return <details className="lpr-empty-detail"><summary>Checks <span>Not configured</span></summary><p className="pr-empty">Add project scripts to <code>.tau/project.json</code> to run them here.</p></details>;
  }
  const latest = latestRuns(runs, state.directory);
  return (
    <><h2>Checks</h2><div className="lpr-checks" role="list" aria-label="Checks">
      {state.scripts.map((script) => {
        const run = latest.get(script.id);
        return (
          <div key={script.id} className="lpr-check" role="listitem">
            <RunState run={run} />
            <strong>{script.name}</strong>
            <code title={script.command}>{script.command}</code>
            <span className="spacer" />
            {run?.status === "running" ? (
              <button className="mini-button" aria-label={`Stop ${script.name}`} disabled={!mayStop} {...tooltipProps(mayStop ? undefined : READ_ONLY_REASON)} onClick={() => void scripts.invoke("stop", { runId: run.id }).catch((reason: unknown) => setError(errorMessage(reason)))}>
                <Square size={11} aria-hidden="true" /> Stop
              </button>
            ) : (
              <button className="mini-button" aria-label={`Run ${script.name}`} disabled={!mayRun} {...tooltipProps(mayRun ? undefined : READ_ONLY_REASON)} onClick={() => void start(script)}>
                <Play size={11} aria-hidden="true" /> Run
              </button>
            )}
          </div>
        );
      })}
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
    </div></>
  );
}
