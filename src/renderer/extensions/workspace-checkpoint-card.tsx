import type { UiWorkspaceChangesPage } from "../../shared/workspace-kit-types";
import type { UiTurnCheckpoint } from "../../shared/turn-checkpoint-types";
import { ChangedFiles } from "../components/ChangedFiles";

/** Workspace Kit's optional transcript contribution for immutable turn changes. */
export interface WorkspaceCheckpointCardProps {
  checkpoint: UiTurnCheckpoint;
  onOpenDiff(path?: string): void;
  /** Starts the explicit confirmation flow for destructive restore. */
  onRestore?(): void;
  loadFiles?(cursor?: string, limit?: number): Promise<UiWorkspaceChangesPage>;
}

export function WorkspaceCheckpointCard({ checkpoint, onOpenDiff, onRestore, loadFiles }: WorkspaceCheckpointCardProps) {
  return (
    <div className="turn-checkpoint-card" data-checkpoint-id={checkpoint.id}>
      <ChangedFiles
        changes={checkpoint}
        label="Turn changes"
        onOpenDiff={onOpenDiff}
        onRestore={onRestore}
        loadFiles={loadFiles}
      />
    </div>
  );
}
