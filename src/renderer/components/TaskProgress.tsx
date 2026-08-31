import { Check, ChevronRight, Circle, ListTodo } from "lucide-react";
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

export const TaskProgress = memo(function TaskProgress({
  progress,
  placement,
}: {
  progress: UiTaskProgress;
  placement: "dock" | "transcript";
}) {
  const [expanded, setExpanded] = useState(false);
  const current = progress.tasks.find((task) => task.status === "in_progress")
    ?? progress.tasks.find((task) => task.status === "pending")
    ?? progress.tasks.at(-1);

  return <section className={`task-progress ${placement}${expanded ? " expanded" : ""}`}>
    <button type="button" className="task-progress-header" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
      {placement === "dock"
        ? <><ListTodo size={16} strokeWidth={1.7} /><strong>Tasks</strong></>
        : <><ListTodo size={16} strokeWidth={1.7} /><ProgressSegments progress={progress} /></>}
      {current ? <span className="task-progress-current">{taskLabel(current)}</span> : null}
      <span className="task-progress-count">{progress.completed}/{progress.total}</span>
      {placement === "dock" ? <ProgressSegments progress={progress} /> : null}
      <ChevronRight className="task-progress-chevron" size={14} />
    </button>
    {expanded ? <div className="task-progress-list">
      {progress.tasks.map((task) => <div key={task.id} className={`task-progress-item ${task.status}`}>
        <span className="task-progress-status">
          {task.status === "completed" ? <Check size={13} /> : <Circle size={10} fill={task.status === "in_progress" ? "currentColor" : "none"} />}
        </span>
        <span>{taskLabel(task)}</span>
      </div>)}
    </div> : null}
  </section>;
});
