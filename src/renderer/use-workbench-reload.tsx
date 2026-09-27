import { lazy, Suspense, useCallback, useState } from "react";
import type { ReloadPhase } from "./components/ReloadCurtain";
import { ReloadCurtain } from "./deferred-surfaces";
import { errorMessage } from "../workbench/error-message";
import type { WorkbenchBuildResult } from "../shared/contracts";
import type { HostClient } from "../workbench/host-client";

const LazyReloadConflictDialog = lazy(() => import("./components/ReloadConflictDialog").then(({ ReloadConflictDialog }) => ({ default: ReloadConflictDialog })));

/**
 * What a build has to be applied with. Only a change the host cannot swap out
 * from under a running thread — the agent runtime's own halves, or the main
 * process — stops anything; everything else reloads kits and the page.
 */
export type ReloadRoute = "extensions" | "runtime" | "relaunch";

export function reloadRouteFor(result: WorkbenchBuildResult): ReloadRoute {
  if (result.mainChanged) return "relaunch";
  return result.runtimeChanged ? "runtime" : "extensions";
}

export function useWorkbenchReload(options: {
  client: HostClient | undefined;
  requireHost(what: string): boolean;
  addEvent(label: string, detail?: string): void;
  setNotice(message?: string): void;
}) {
  const { client, requireHost, addEvent, setNotice } = options;
  const [phase, setPhase] = useState<ReloadPhase>();
  const [conflictCount, setConflictCount] = useState<number>();
  const [pendingRoute, setPendingRoute] = useState<ReloadRoute>();

  /** The half that needs the host to hold still: a runtime reload or a restart. */
  const applyHeldRoute = useCallback(async (route: ReloadRoute) => {
    setPhase("extensions");
    try {
      await client!.reloadRuntime();
      if (route === "relaunch") {
        setPhase("restarting");
        await client!.relaunchWorkbench();
      } else {
        await client!.releaseWorkbenchReload();
        window.location.reload();
      }
      return true;
    } catch (error) {
      setPhase(undefined);
      await client!.releaseWorkbenchReload().catch(() => undefined);
      setNotice(errorMessage(error));
      return false;
    }
  }, [client, setNotice]);

  /** Kits and the page only. Nothing is drained, so a running turn never sees it. */
  const applyExtensionReload = useCallback(async () => {
    setPhase("extensions");
    try {
      await client!.reloadExtensions();
      window.location.reload();
      return true;
    } catch (error) {
      setPhase(undefined);
      setNotice(errorMessage(error));
      return false;
    }
  }, [client, setNotice]);

  const startHeldRoute = useCallback(async (route: ReloadRoute) => {
    const preparation = await client!.prepareWorkbenchReload("inspect");
    if (preparation.ready) return applyHeldRoute(route);
    setPhase(undefined);
    setPendingRoute(route);
    setConflictCount(preparation.runningThreads);
    return true;
  }, [applyHeldRoute, client]);

  const reloadWorkbench = useCallback(async () => {
    if (!requireHost("Reloading")) return false;
    setPhase("building");
    try {
      // The build comes first: only its result says whether anything has to
      // hold still, and building never disturbs a thread.
      const result = await client!.rebuildWorkbench();
      if (!result.ok) {
        setPhase(undefined);
        addEvent("workbench.build.failed", result.output);
        setNotice(`Build failed: ${result.output.split("\n").filter(Boolean).at(-1) ?? "see Signals"}`);
        return false;
      }
      const route = reloadRouteFor(result);
      return route === "extensions" ? applyExtensionReload() : startHeldRoute(route);
    } catch (error) {
      setPhase(undefined);
      setNotice(errorMessage(error));
      return false;
    }
  }, [addEvent, applyExtensionReload, client, requireHost, setNotice, startHeldRoute]);

  const continueReload = useCallback(async (mode: "wait" | "abort") => {
    const route = pendingRoute ?? "runtime";
    setConflictCount(undefined);
    setPendingRoute(undefined);
    if (mode === "wait") setNotice("Reload queued until running threads finish.");
    try {
      await client!.prepareWorkbenchReload(mode);
      setNotice(undefined);
      await applyHeldRoute(route);
    } catch (error) {
      await client!.releaseWorkbenchReload().catch(() => undefined);
      setNotice(errorMessage(error));
    }
  }, [applyHeldRoute, client, pendingRoute, setNotice]);

  const reloadUi = <>
    {conflictCount !== undefined ? <Suspense fallback={null}><LazyReloadConflictDialog
      runningThreads={conflictCount}
      onCancel={() => { setConflictCount(undefined); setPendingRoute(undefined); }}
      onWait={() => void continueReload("wait")}
      onAbort={() => void continueReload("abort")}
    /></Suspense> : null}
    {phase ? <ReloadCurtain phase={phase} /> : null}
  </>;
  return { reloadWorkbench, reloadUi };
}
