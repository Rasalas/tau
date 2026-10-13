import { Bot, Eye, SquareTerminal, Zap } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { backgroundHoldsRun, backgroundSummary } from "../../shared/background-work";
import type { UiBackgroundTask } from "../../shared/contracts";
import { Popover } from "../deferred-surfaces";
import { errorMessage } from "../../workbench/error-message";
import "./BackgroundPill.css";
import { TASK_PILL_CLOSE_DELAY_MS, TASK_PILL_OPEN_DELAY_MS } from "./TaskProgress";

function KindIcon({ kind }: { kind: UiBackgroundTask["kind"] }) {
  if (kind === "command") return <SquareTerminal aria-hidden="true" />;
  if (kind === "agent") return <Bot aria-hidden="true" />;
  if (kind === "task") return <Zap aria-hidden="true" />;
  return <Eye aria-hidden="true" />;
}

const READ_ONLY = "This paired device is read-only. Stop it in Tau on the machine itself.";
const KIND: Record<UiBackgroundTask["kind"], string> = { command: "Command", monitor: "Monitor", agent: "Sub-agent", task: "Task" };
const clock = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

/**
 * What the thread's runtime still runs in the background, as a pill beside the
 * goal: Monitoring, Waiting or Running. Its popover lists each task with a stop.
 */
export const BackgroundPill = memo(function BackgroundPill({ tasks, runtime, readOnly, onStop }: {
  tasks: readonly UiBackgroundTask[];
  runtime: string;
  readOnly: boolean;
  onStop(taskId?: string): Promise<void>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const open = pinned || hovered;
  const { label, hint } = backgroundSummary(tasks);
  const commandsOnly = !tasks.some((task) => task.kind !== "command");
  const holds = backgroundHoldsRun(tasks);

  const hover = (next: boolean) => (event: ReactPointerEvent) => {
    if (event.pointerType !== "mouse") return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setHovered(next), next ? TASK_PILL_OPEN_DELAY_MS : TASK_PILL_CLOSE_DELAY_MS);
  };
  const close = () => {
    clearTimeout(timer.current);
    setPinned(false);
    setHovered(false);
  };
  const stop = async (taskId?: string) => {
    setBusy(taskId ?? "all");
    setError(undefined);
    try {
      await onStop(taskId);
      if (!taskId || tasks.length === 1) close();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(undefined);
    }
  };

  return <>
    <button
      ref={anchor}
      type="button"
      className={`control-pill background-pill${backgroundHoldsRun(tasks) ? " holds" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={hint}
      onPointerEnter={hover(true)}
      onPointerLeave={hover(false)}
      onClick={() => {
        clearTimeout(timer.current);
        if (pinned) close();
        else setPinned(true);
      }}
    >
      {commandsOnly ? <SquareTerminal aria-hidden="true" /> : <Eye aria-hidden="true" />}
      <span>{label}</span>
      {tasks.length > 1 ? <span className="background-pill-count">{tasks.length}</span> : null}
    </button>
    {open ? <Popover anchor={anchor} side="top" align="center" label="Background work" className="background-popover" takeFocus={false} onClose={close}>
      <div className="background-popover-body" onPointerEnter={hover(true)} onPointerLeave={hover(false)} tabIndex={-1}>
        <header className="background-popover-head"><strong>In the background</strong></header>
        <ul className="background-list">{tasks.map((task) => <li key={task.id}>
          <KindIcon kind={task.kind} />
          <div className="background-row-text">
            <span className="background-row-label">{task.label}</span>
            <span className="background-row-meta">{task.state === "reported" ? "Result ready" : KIND[task.kind]}{task.blocksCompletion === false ? " · service" : ""}{task.startedAt !== undefined ? ` · since ${clock(task.startedAt)}` : ""}</span>
          </div>
          <button type="button" aria-label={`Stop ${task.label}`} disabled={readOnly || Boolean(busy)} title={readOnly ? READ_ONLY : undefined} onClick={() => void stop(task.id)}>{busy === task.id ? "Stopping…" : "Stop"}</button>
        </li>)}</ul>
        <p className="background-explanation">{tasks.some((task) => task.state === "reported")
          ? `${runtime} still needs to handle the result. The request remains open.`
          : holds ? `${runtime} continues when this work reports. The request remains open until the results are handled.`
          : "These checked services keep running independently. They do not hold the request open."}</p>
        {error ? <p className="background-error" role="alert">{error}</p> : null}
        {tasks.length > 1 ? <footer className="background-actions">
          <button type="button" disabled={readOnly || Boolean(busy)} title={readOnly ? READ_ONLY : undefined} onClick={() => void stop()}>{busy === "all" ? "Stopping…" : "Stop all"}</button>
        </footer> : null}
      </div>
    </Popover> : null}
  </>;
});
