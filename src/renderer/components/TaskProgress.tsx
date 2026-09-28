import { CheckCircle2, ChevronRight, Circle, ListTodo, LoaderCircle } from "lucide-react";
import { memo, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { UiTask, UiTaskProgress } from "../../shared/contracts";
import { Popover } from "../deferred-surfaces";

/** The same rest and grace as the turn's pill beside it, so the row's pills open alike. */
export const TASK_PILL_OPEN_DELAY_MS = 180;
export const TASK_PILL_CLOSE_DELAY_MS = 220;

function taskLabel(task: UiTask): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
}

function currentTask(progress: UiTaskProgress): UiTask | undefined {
  return progress.tasks.find((task) => task.status === "in_progress")
    ?? progress.tasks.find((task) => task.status === "pending");
}

/** Done of all: the count always equals the solid segments of the bar. */
export function taskSummary(progress: UiTaskProgress): string {
  return `${progress.completed} of ${progress.total} done`;
}

function ProgressSegments({ progress }: { progress: UiTaskProgress }) {
  const tasks = progress.tasks.slice(0, 10);
  return <span className="task-progress-segments" aria-hidden="true">
    {tasks.map((task) => <i key={task.id} className={task.status} />)}
  </span>;
}

function TaskList({ progress }: { progress: UiTaskProgress }) {
  return <div className="task-progress-list">
    {progress.tasks.map((task) => <div key={task.id} className={`task-progress-item ${task.status}`}>
      <span className="task-progress-status">
        {task.status === "completed"
          ? <CheckCircle2 size={15} />
          : task.status === "in_progress"
            ? <LoaderCircle className="task-progress-spinner" size={15} />
            : <Circle size={15} />}
      </span>
      <span>{taskLabel(task)}</span>
    </div>)}
  </div>;
}

/** A task snapshot in the transcript, where the turn made it. */
export const TaskProgress = memo(function TaskProgress({ progress }: { progress: UiTaskProgress }) {
  const [expanded, setExpanded] = useState(false);
  const current = currentTask(progress) ?? progress.tasks.at(-1);
  return <section className={`task-progress transcript${expanded ? " expanded" : ""}`}>
    <button type="button" className="task-progress-header" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      <ListTodo size={16} strokeWidth={1.7} />
      <ProgressSegments progress={progress} />
      {current ? <span className="task-progress-current">{taskLabel(current)}</span> : null}
      <span className="task-progress-count">{progress.completed}/{progress.total}</span>
      <ChevronRight className="task-progress-chevron" size={14} />
    </button>
    {expanded ? <TaskList progress={progress} /> : null}
  </section>;
});

/**
 * The running task list as a pill in the row over the composer, beside the turn's changes.
 * A resting mouse or a click opens the list above it; a click keeps it open until Escape or a press outside.
 */
export const TaskPill = memo(function TaskPill({ progress }: { progress: UiTaskProgress }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const open = pinned || hovered;
  const done = progress.total > 0 && progress.completed >= progress.total;
  const current = done ? undefined : currentTask(progress);
  const summary = taskSummary(progress);

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

  return <>
    <button
      ref={anchor}
      type="button"
      className={`control-pill task-progress-pill${done ? " done" : ""}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`Tasks: ${summary}${current ? `, now: ${taskLabel(current)}` : ""}`}
      onPointerEnter={hover(true)}
      onPointerLeave={hover(false)}
      onClick={() => {
        clearTimeout(timer.current);
        if (pinned) close();
        else setPinned(true);
      }}
    >
      <ListTodo aria-hidden="true" />
      <ProgressSegments progress={progress} />
      <span className="task-progress-count">{progress.completed}/{progress.total}</span>
    </button>
    {open ? <Popover anchor={anchor} side="top" align="center" label="Tasks" className="task-progress-popover" onClose={close}>
      <div onPointerEnter={hover(true)} onPointerLeave={hover(false)}>
        <header className="task-progress-head"><strong>Tasks</strong><span>{summary}</span></header>
        <TaskList progress={progress} />
      </div>
    </Popover> : null}
  </>;
});
