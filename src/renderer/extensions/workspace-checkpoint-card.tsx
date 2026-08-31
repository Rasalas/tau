import type { TurnCheckpointContributionProps } from "../extension-system";
import { ChangedFiles } from "../components/ChangedFiles";

/** Workspace Kit's optional transcript contribution for immutable turn changes. */
export function WorkspaceCheckpointCard({ checkpoint, onOpenDiff, loadFiles }: TurnCheckpointContributionProps) {
  return (
    <div className="turn-checkpoint-card" data-checkpoint-id={checkpoint.id}>
      <ChangedFiles
        changes={checkpoint}
        label="Turn changes"
        onOpenDiff={onOpenDiff}
        loadFiles={loadFiles}
      />
    </div>
  );
}
