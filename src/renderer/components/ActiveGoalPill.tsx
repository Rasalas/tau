import { lazy, Suspense, useEffect } from "react";
import { showGoal } from "../goal-state";
import { useThreadShell } from "../use-thread-shell";

const GoalPill = lazy(() => import("./GoalPill").then((module) => ({ default: module.GoalPill })));

/** The thread's native goal; its controls and styles load only when it has one. */
export function ActiveGoalPill({ sessionId, supported, runtime, readOnly, onAction }: {
  sessionId: string | undefined;
  supported: boolean;
  runtime: string;
  readOnly: boolean;
  onAction(action: "pause" | "resume" | "clear" | "dismiss"): Promise<void>;
}) {
  const goal = useThreadShell(sessionId ?? "")?.goal;
  useEffect(() => { showGoal(sessionId, goal, supported); }, [sessionId, goal, supported]);
  useEffect(() => () => showGoal(undefined, undefined, false), []);
  return sessionId && goal ? <Suspense fallback={null}><GoalPill goal={goal} runtime={runtime} readOnly={readOnly} onAction={onAction} /></Suspense> : null;
}
