import { CircleAlert, CircleCheck, CirclePause, CircleHelp, Target } from "lucide-react";
import { memo, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { UiGoalStatus, UiThreadGoal } from "../../shared/contracts";
import { Popover } from "../deferred-surfaces";
import { errorMessage } from "../../workbench/error-message";
import { goalResumable } from "../goal-state";
import "./GoalPill.css";
import { TASK_PILL_CLOSE_DELAY_MS, TASK_PILL_OPEN_DELAY_MS } from "./TaskProgress";

export const READ_ONLY_GOAL = "This paired device is read-only. Change it on the host's own window.";

type GoalAction = "pause" | "resume" | "clear" | "dismiss";

/** Blue only while it runs (K70); amber when it waits on the user; green only when the runtime confirmed it. */
const TONE: Record<UiGoalStatus, "running" | "rest" | "waiting" | "done"> = {
  "active": "running",
  "paused": "rest",
  "blocked": "waiting",
  "usage-limited": "waiting",
  "budget-limited": "waiting",
  "complete": "done",
  "unconfirmed": "waiting",
};

const LABEL: Record<UiGoalStatus, string> = {
  "active": "Goal",
  "paused": "Goal paused",
  "blocked": "Goal blocked",
  "usage-limited": "Usage limit",
  "budget-limited": "Budget reached",
  "complete": "Goal met",
  "unconfirmed": "Goal not confirmed",
};

const TITLE: Record<UiGoalStatus, string> = {
  "active": "Pursuing goal",
  "paused": "Goal paused",
  "blocked": "Goal blocked",
  "usage-limited": "Goal hit a usage limit",
  "budget-limited": "Goal reached its token budget",
  "complete": "Goal met",
  "unconfirmed": "Goal not confirmed",
};

function explanation(goal: UiThreadGoal, runtime: string): string {
  switch (goal.status) {
    case "active":
      return goal.actions.pause
        ? `${runtime} starts the next turn on its own until the goal is met. Pause lets the running turn finish.`
        : `${runtime} keeps working until a separate check says the goal is met. It can't pause a goal: Stop ends the turn and the goal stays set.`;
    case "paused": return "Nothing starts until you resume it.";
    case "blocked": return `${runtime} stopped working on the goal and needs you.`;
    case "usage-limited": return "The account reached a usage limit. Resume once it resets.";
    case "budget-limited": return "The goal used its token budget.";
    case "complete": return `${runtime} confirmed the goal is met.`;
    case "unconfirmed": return `${runtime} stopped without a verdict. Tau doesn't know whether the goal is met; check the result before relying on it.`;
  }
}

export function compactTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${Math.round(tokens / 100) / 10}k`.replace(".0k", "k");
  return `${Math.round(tokens / 100_000) / 10}M`.replace(".0M", "M");
}

function GoalIcon({ status }: { status: UiGoalStatus }) {
  if (status === "paused") return <CirclePause aria-hidden="true" />;
  if (status === "complete") return <CircleCheck aria-hidden="true" />;
  if (status === "unconfirmed") return <CircleHelp aria-hidden="true" />;
  if (status === "active") return <Target aria-hidden="true" />;
  return <CircleAlert aria-hidden="true" />;
}

/** What the popover offers, the safe and common one first: it takes the focus. */
function actionsFor(goal: UiThreadGoal): Array<{ action: GoalAction; label: string; primary?: boolean }> {
  switch (goal.status) {
    case "active": return goal.actions.pause ? [{ action: "pause", label: "Pause" }, { action: "clear", label: "End goal" }] : [{ action: "clear", label: "End goal" }];
    case "paused":
    case "blocked":
    case "usage-limited":
      return [...goalResumable(goal) ? [{ action: "resume" as const, label: "Resume", primary: true }] : [], { action: "clear", label: "End goal" }];
    case "budget-limited": return [{ action: "clear", label: "End goal" }];
    case "complete": return [{ action: "dismiss", label: "Done", primary: true }];
    case "unconfirmed": return [{ action: "dismiss", label: "Dismiss" }, ...goalResumable(goal) ? [{ action: "resume" as const, label: "Resume" }] : []];
  }
}

/**
 * The thread's native goal as a pill in the row over the composer, beside the
 * tasks. A resting mouse or a click opens what it is after, what it used and
 * what can be done; Stop in the composer pauses it in one press.
 */
export const GoalPill = memo(function GoalPill({ goal, runtime, readOnly, onAction }: {
  goal: UiThreadGoal;
  /** The runtime's name, for the explanation. */
  runtime: string;
  readOnly: boolean;
  onAction(action: GoalAction): Promise<void>;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [pinned, setPinned] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const first = useRef<HTMLButtonElement>(null);
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setError(undefined); }, [goal.status]);
  const open = pinned || hovered;
  const tone = TONE[goal.status];
  const actions = actionsFor(goal);
  // A popover whose one action ends something takes the focus itself, so Enter ends nothing by accident.
  const focusAction = actions.length === 1 && actions[0]!.action === "clear" ? undefined : actions[0]?.action;
  useLayoutEffect(() => { if (pinned) (first.current ?? body.current)?.focus({ preventScroll: true }); }, [pinned]);

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
  const run = async (action: GoalAction) => {
    setBusy(true);
    setError(undefined);
    try {
      await onAction(action);
      if (action === "clear" || action === "dismiss") close();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  const tokens = goal.tokensUsed !== undefined ? compactTokens(goal.tokensUsed) : undefined;

  return <>
    <button
      ref={anchor}
      type="button"
      className={`control-pill goal-pill ${tone}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={`${TITLE[goal.status]}: ${goal.objective}`}
      onPointerEnter={hover(true)}
      onPointerLeave={hover(false)}
      onClick={() => {
        clearTimeout(timer.current);
        if (pinned) close();
        else setPinned(true);
      }}
    >
      <GoalIcon status={goal.status} />
      <span>{LABEL[goal.status]}</span>
      {goal.status === "active" && tokens ? <span className="goal-pill-tokens">{tokens}</span> : null}
    </button>
    {open ? <Popover anchor={anchor} side="top" align="center" label="Goal" className="goal-popover" onClose={close}>
      <div ref={body} className={`goal-popover-body ${tone}`} onPointerEnter={hover(true)} onPointerLeave={hover(false)} tabIndex={-1}>
        <header className="goal-popover-head"><GoalIcon status={goal.status} /><strong>{TITLE[goal.status]}</strong></header>
        <p className="goal-objective">{goal.objective}</p>
        <dl className="goal-facts">
          {goal.tokensUsed !== undefined ? <><dt>Tokens</dt><dd>{compactTokens(goal.tokensUsed)}{goal.tokenBudget !== undefined ? ` of ${compactTokens(goal.tokenBudget)}` : ""}</dd></> : null}
          {goal.turns !== undefined ? <><dt>Turns</dt><dd>{goal.turns}</dd></> : null}
        </dl>
        <p className="goal-explanation">{explanation(goal, runtime)}</p>
        {goal.reason ? <p className="goal-reason">{goal.reason}</p> : null}
        {error ? <p className="goal-error" role="alert">{error}</p> : null}
        <footer className="goal-actions">
          {actions.map((entry) => <button
            key={entry.action}
            ref={entry.action === focusAction ? first : undefined}
            type="button"
            className={entry.primary ? "primary" : undefined}
            disabled={readOnly || busy}
            title={readOnly ? READ_ONLY_GOAL : undefined}
            onClick={() => void run(entry.action)}
          >{entry.label}</button>)}
        </footer>
        {readOnly ? <p className="goal-read-only">{READ_ONLY_GOAL}</p> : null}
      </div>
    </Popover> : null}
  </>;
});

