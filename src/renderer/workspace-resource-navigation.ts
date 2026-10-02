import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";
import { activeTab, openFileTab, stageTabPath, type StageState, type StageTab, type WorkspaceResourceOrigin } from "../workbench/stage";
import { resourceRelativePath } from "./workspace-resource-context";

/** Resource readers are not authority for commands against another project's files. */
export function actionableStageTab(tab: StageTab | undefined, workspace: string | undefined, sourceId: string | undefined): StageTab | undefined {
  if (tab?.kind !== "file" || tab.resourceOrigin === undefined) return tab;
  const origin = tab.resourceOrigin;
  if (!origin || !workspace || origin.workspace !== workspace || !sourceId || origin.sourceId !== sourceId) return undefined;
  try { resourceRelativePath(tab.path); return tab; }
  catch { return undefined; }
}

/** Stage ownership and resource identity stay here, rather than adding policy to App. */
export function useWorkspaceResourceNavigation({ stage, setStage, workspace, sourceId, reveal }: {
  stage: StageState;
  setStage: Dispatch<SetStateAction<StageState>>;
  workspace?: string;
  sourceId?: string;
  reveal: RefObject<() => void>;
}) {
  const openWorkspaceFile = useCallback((path: string, origin: WorkspaceResourceOrigin | null) => {
    setStage((current) => openFileTab(current, path, { resourceOrigin: origin, localWorkspace: workspace }));
    reveal.current();
  }, [setStage, workspace, reveal]);
  const activeDocumentPath = stageTabPath(actionableStageTab(activeTab(stage), workspace, sourceId));
  return { openWorkspaceFile, activeDocumentPath };
}
