import { useSyncExternalStore } from "react";
import { Check } from "lucide-react";
import { useWorkbench, type RegionProps, type ToolPresentation, type UiToolRun } from "tau";
import { isBusyStatus } from "./protocol.js";
import { agentsStore } from "./store.js";

export interface SpineStep {
  label: string;
  running: boolean;
}

const VERBS = { read: ["Read", "Reading", "files"], write: ["Edited", "Editing", "files"], shell: ["Ran", "Running", "commands"] } as const;

/** The turn's tool runs as the spine lists them: one step per run of the same kind, "Read 2 files", "Running vitest". */
export function spineSteps(tools: readonly UiToolRun[], present: (tool: UiToolRun) => ToolPresentation): SpineStep[] {
  const steps: (SpineStep & { tone: string; count: number })[] = [];
  for (const tool of tools) {
    const view = present(tool);
    const running = tool.status === "running";
    const last = steps.at(-1);
    if (view.tone === "neutral") { steps.push({ label: view.title, running, tone: "", count: 1 }); continue; }
    const verbs = VERBS[view.tone];
    const count = last?.tone === view.tone ? last.count + 1 : 1;
    // The Now card shows a whole command; its step names the program, a file step the file's name.
    const subject = count > 1 ? `${count} ${verbs[2]}` : (view.tone === "shell" ? view.detail.trim().split(/\s+/u)[0] : (view.file ?? view.detail).split(/[\\/]/u).at(-1)) || view.detail;
    const busy = running || (count > 1 && last!.running);
    const step = { label: `${verbs[busy ? 1 : 0]} ${subject}`, running: busy, tone: view.tone, count };
    if (count > 1) steps[steps.length - 1] = step; else steps.push(step);
  }
  return steps.map(({ label, running }) => ({ label, running }));
}

/** Under the spine's title and state (design 1b): what runs now, the turn's steps, and one line for its agents. */
export function AgentsSpine({ snapshot }: RegionProps) {
  const { tools, registry } = useWorkbench();
  const agents = useSyncExternalStore(agentsStore.subscribe, agentsStore.getSnapshot);
  const id = snapshot?.sessionId ?? "";
  const now = snapshot?.isStreaming ? [...tools].reverse().find((tool) => tool.status === "running") : undefined;
  const progress = snapshot?.taskProgress;
  const mine = agents?.links.filter((link) => link.parentThreadId === id && (isBusyStatus(link.status) || link.status === "pending")) ?? [];
  const asking = mine.filter((link) => link.status === "waiting").length;
  const steps = spineSteps(tools, (tool) => registry.presentTool(tool)).slice(-8);
  const spinner = <span className="spinner small" aria-hidden />;
  return <>
    {now ? <div className="agents-spine-now">
      <small>Now</small>
      <code>{registry.presentTool(now).detail}</code>
      <span className={progress ? "agents-spine-bar" : "agents-spine-bar busy"}>
        <i style={progress ? { width: `${Math.round((progress.completed / Math.max(1, progress.total)) * 100)}%` } : undefined} />
      </span>
      {progress ? <small>{progress.completed} of {progress.total} tasks</small> : null}
    </div> : null}
    {steps.length > 0 ? <ol className="agents-spine-steps">
      {steps.map((step, index) => <li key={index} className={step.running ? "running" : undefined}>{step.running ? spinner : <Check size={10} aria-hidden />}{step.label}</li>)}
    </ol> : null}
    {mine.length > 0 ? <p className="agents-spine-agents">
      {mine.length} {mine.length === 1 ? "agent" : "agents"}{asking ? <> · <b>{asking} {asking === 1 ? "question" : "questions"}</b></> : null}
    </p> : null}
  </>;
}
