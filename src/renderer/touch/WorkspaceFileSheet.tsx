import { useMemo } from "react";
import type { StageFileTab } from "../../workbench/stage";
import type { DocumentSourceContribution } from "../extension-system";
import { useHostClient } from "../host-client-context";
import { bindWorkspaceFileLoader } from "../workspace-resource-context";
import { FileViewer } from "../components/FileViewer";
import { Sheet } from "./Sheet";

/** A phone reader, not the desktop stage or an editor. Its tab persists with the thread. */
export function WorkspaceFileSheet({ tab, source, onClose }: { tab: StageFileTab; source?: DocumentSourceContribution; onClose(): void }) {
  const client = useHostClient();
  const loadFile = useMemo(() => bindWorkspaceFileLoader(source, tab.resourceOrigin), [client, source, tab.resourceOrigin]);
  return <Sheet title={tab.path.split("/").at(-1) || "Workspace file"} onClose={onClose}>
    <FileViewer tab={{ ...tab, view: "source" }} relativePath={tab.path} changed={false}
      loadFile={loadFile} loadDiff={async () => { throw new Error("This reader shows source only."); }}
      onChangeView={() => undefined} onOpenInEditor={() => undefined} onClose={onClose} />
  </Sheet>;
}
