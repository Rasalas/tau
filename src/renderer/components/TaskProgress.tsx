import { CheckCircle2, ChevronRight, Circle, ListTodo, LoaderCircle } from "lucide-react";
import { memo, useState } from "react";
import type { UiTask, UiTaskProgress } from "../../shared/contracts";

function taskLabel(task: UiTask): string {
  return task.status === "in_progress" && task.activeForm ? task.activeForm : task.subject;
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

export const TaskProgress = memo(function TaskProgress({
  progress,
  placement,
}: {
  progress: UiTaskProgress;
  placement: "dock" | "transcript";
}) {
  const [expanded, setExpanded] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const current = progress.tasks.find((task) => task.status === "in_progress")
    ?? progress.tasks.find((task) => task.status === "pending")
    ?? progress.tasks.at(-1);
  const currentStep = progress.total === 0 ? 0 : Math.min(progress.completed + 1, progress.total);
  const showList = expanded || previewing;

  return <section
    className={`task-progress ${placement}${showList ? " expanded" : ""}`}
    onMouseEnter={placement === "dock" ? () => setPreviewing(true) : undefined}
    onMouseLeave={placement === "dock" ? () => setPreviewing(false) : undefined}
    onFocusCapture={placement === "dock" ? () => setPreviewing(true) : undefined}
    onBlurCapture={placement === "dock" ? (event) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setPreviewing(false);
    } : undefined}
  >
    <button
      type="button"
      className="task-progress-header"
      aria-expanded={showList}
      aria-label={placement === "dock" ? `Tasks, step ${currentStep} of ${progress.total}` : undefined}
      onClick={() => setExpanded((value) => !value)}
    >
      <ListTodo size={16} strokeWidth={1.7} />
      <ProgressSegments progress={progress} />
      {placement === "transcript" && current ? <span className="task-progress-current">{taskLabel(current)}</span> : null}
      <span className="task-progress-count">{placement === "dock" ? currentStep : progress.completed}/{progress.total}</span>
      {placement === "transcript" ? <ChevronRight className="task-progress-chevron" size={14} /> : null}
    </button>
    {showList ? <TaskList progress={progress} /> : null}
  </section>;
});
