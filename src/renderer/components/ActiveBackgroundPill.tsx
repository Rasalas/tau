import { lazy, Suspense } from "react";
import { useThreadShell } from "../use-thread-shell";

const BackgroundPill = lazy(() => import("./BackgroundPill").then((module) => ({ default: module.BackgroundPill })));

/** The thread's background work; its popover and styles load only while there is some. */
export function ActiveBackgroundPill({ sessionId, runtime, readOnly, onStop }: {
  sessionId: string | undefined;
  runtime: string;
  readOnly: boolean;
  onStop(taskId?: string): Promise<void>;
}) {
  const tasks = useThreadShell(sessionId ?? "")?.background;
  return sessionId && tasks?.length ? <Suspense fallback={null}><BackgroundPill tasks={tasks} runtime={runtime} readOnly={readOnly} onStop={onStop} /></Suspense> : null;
}
