import type { ThreadBranch, ThreadBranchService } from "tau";
import type { WorkspaceKitState } from "./protocol.js";

/** The branch the store follows, as `THREAD_BRANCH_SERVICE` hands it to other packages: one object per change. */
export function threadBranchService(store: { getSnapshot(): WorkspaceKitState; subscribe(listener: () => void): () => void }): ThreadBranchService {
  let last: ThreadBranch | undefined;
  return {
    current: () => {
      const { cwd, workspace } = store.getSnapshot();
      if (!cwd) {
        last = undefined;
        return undefined;
      }
      const next: ThreadBranch = {
        cwd,
        isRepo: workspace?.isRepo ?? false,
        ...(workspace?.branch ? { branch: workspace.branch } : {}),
        ...(workspace?.upstream ? { upstream: workspace.upstream } : {}),
      };
      if (!last || last.cwd !== next.cwd || last.isRepo !== next.isRepo || last.branch !== next.branch || last.upstream !== next.upstream) last = next;
      return last;
    },
    subscribe: (listener) => store.subscribe(listener),
  };
}
