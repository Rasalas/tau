import { useCallback, useState } from "react";
import { ReloadConflictDialog } from "./components/ReloadConflictDialog";
import { ReloadCurtain, type ReloadPhase } from "./components/ReloadCurtain";
import { errorMessage } from "./error-message";
import type { HostClient } from "./host-client";

export function useWorkbenchReload(options: {
  client: HostClient | undefined;
  requireHost(what: string): boolean;
  addEvent(label: string, detail?: string): void;
  setNotice(message?: string): void;
}) {
  const { client, requireHost, addEvent, setNotice } = options;
  const [phase, setPhase] = useState<ReloadPhase>();
  const [conflictCount, setConflictCount] = useState<number>();

  const applyPreparedReload = useCallback(async () => {
    setPhase("building");
    try {
      const result = await client!.rebuildWorkbench();
      if (!result.ok) {
        setPhase(undefined);
        await client!.releaseWorkbenchReload();
        addEvent("workbench.build.failed", result.output);
        setNotice(`Build failed: ${result.output.split("\n").filter(Boolean).at(-1) ?? "see Signals"}`);
        return false;
      }
      setPhase("extensions");
      await client!.reloadRuntime();
      if (result.mainChanged) {
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
  }, [addEvent, client, setNotice]);

  const reloadWorkbench = useCallback(async () => {
    if (!requireHost("Reloading")) return false;
    try {
      const preparation = await client!.prepareWorkbenchReload("inspect");
      if (!preparation.ready) { setConflictCount(preparation.runningThreads); return true; }
      return applyPreparedReload();
    } catch (error) {
      setNotice(errorMessage(error));
      return false;
    }
  }, [applyPreparedReload, client, requireHost, setNotice]);

  const continueReload = useCallback(async (mode: "wait" | "abort") => {
    setConflictCount(undefined);
    if (mode === "wait") setNotice("Reload queued until running threads finish.");
    try {
      await client!.prepareWorkbenchReload(mode);
      setNotice(undefined);
      await applyPreparedReload();
    } catch (error) {
      await client!.releaseWorkbenchReload().catch(() => undefined);
      setNotice(errorMessage(error));
    }
  }, [applyPreparedReload, client, setNotice]);

  const reloadUi = <>
    {conflictCount !== undefined ? <ReloadConflictDialog
      runningThreads={conflictCount}
      onCancel={() => setConflictCount(undefined)}
      onWait={() => void continueReload("wait")}
      onAbort={() => void continueReload("abort")}
    /> : null}
    {phase ? <ReloadCurtain phase={phase} /> : null}
  </>;
  return { reloadWorkbench, reloadUi };
}
