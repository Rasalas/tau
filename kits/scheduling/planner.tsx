import { useMemo, useState, useSyncExternalStore, type FormEvent } from "react";
import { errorMessage, useClientStorage, type ComposerPlannerProps } from "tau";
import { describeCron, parseCron } from "./cron.js";
import type { SchedulingFeed } from "./feed.js";
import type { Job, JobConfig } from "./protocol.js";
import { DEFAULT_REPEAT, localTimeZone, RepeatBuilder, repeatProblem } from "./repeat.js";

/** The expression last planned on this device; the tab opens with it. */
export const REPEAT_LAST_KEY = "scheduling.repeat-last";

/** The automation's name: the draft's first line, at most 60 characters. */
export function plannedName(text: string): string {
  const line = text.split("\n").map((entry) => entry.trim()).find(Boolean);
  if (!line) return "Planned message";
  return line.length > 60 ? `${line.slice(0, 59).trimEnd()}…` : line;
}

/** The Plan sheet's Repeat tab: the draft becomes an automation that starts a new thread on each run. */
export default function RepeatPlanner({ draft, snapshot, onPlanned, onCancel, feed }: ComposerPlannerProps & { feed: SchedulingFeed }) {
  const view = useSyncExternalStore(feed.subscribe, feed.get);
  const storage = useClientStorage();
  const [expression, setExpression] = useState(() => {
    const last = storage.get(REPEAT_LAST_KEY);
    try { return last ? parseCron(last).source : DEFAULT_REPEAT; } catch { return DEFAULT_REPEAT; }
  });
  const timezone = useMemo(localTimeZone, []);
  const [created, setCreated] = useState<Job>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const state = view.state;
  const problem = useMemo(() => repeatProblem(expression, timezone, Date.now()), [expression, timezone]);
  const off = Boolean(state?.canManage && !state.enabled);
  const blocked = busy || !state?.canManage || Boolean(problem) || !draft.text.trim() || !snapshot.cwd;
  const plan = async (event: FormEvent) => {
    event.preventDefault();
    if (blocked) return;
    setBusy(true); setError(undefined);
    try {
      // The editor's defaults for a new automation; access follows the new-thread default.
      const config: JobConfig = { name: plannedName(draft.text), workspace: snapshot.cwd, backend: snapshot.backendKind ?? snapshot.defaultBackendKind ?? "pi", prompt: draft.text, schedule: { kind: "cron", expression: parseCron(expression).source, timezone }, workspaceStrategy: "worktree", maxDurationMinutes: 60 };
      const job = created ? await feed.invoke("update", { id: created.id, config }) as Job : await feed.invoke("create", config) as Job;
      // Keep the ID so a retry after a failed enable updates instead of creating a second automation.
      setCreated(job);
      await feed.invoke("enable", { id: job.id });
      if (off) await feed.invoke("set-enabled", { enabled: true });
      storage.set(REPEAT_LAST_KEY, parseCron(expression).source);
      onPlanned(describeCron(expression) ?? `Cron ${parseCron(expression).source}`);
    } catch (failure) { setError(errorMessage(failure)); setBusy(false); }
  };
  return <form className="scheduling-plan" onSubmit={(event) => void plan(event)}>
    <div className="plan-sheet-body">
      <RepeatBuilder expression={expression} timezone={timezone} disabled={busy} onChange={setExpression} />
      {draft.attachments > 0 ? <p className="scheduling-plan-note">Attachments stay with this thread; the automation gets the text only.</p> : null}
      {!draft.text.trim() ? <p className="scheduling-plan-note">Write the message first. An automation sends text.</p> : null}
      {!state && view.error ? <p role="alert" className="scheduling-error">{view.error}</p> : null}
      {state && !state.canManage ? <p className="scheduling-plan-note">This device can't manage automations. Plan this in the machine's own Tau window.</p> : null}
      {error ? <p role="alert" className="scheduling-error">{error}</p> : null}
      {off ? <p className="scheduling-plan-note">Automations are off. Planning turns them on.</p> : null}
    </div>
    <footer className="plan-sheet-footer">
      <span className="plan-sheet-note">Each run in a new thread</span>
      <button type="button" className="text-button" disabled={busy} onClick={onCancel}>Cancel</button>
      <button type="submit" className="primary" disabled={blocked}>{busy ? "Planning…" : off ? "Turn on and plan" : "Plan"}</button>
    </footer>
  </form>;
}
