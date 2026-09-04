/**
 * Worktree Names' contract between its host entry and its desktop entry. The
 * desktop side picks the model and gathers the task; the host side asks the
 * model and answers with a branch name Git accepts.
 */
export const WORKTREE_NAMES_HOST_EXTENSION_ID = "tau.worktree-names";

export interface WorktreeNamesHostCommands {
  "suggest": {
    input: {
      provider: string;
      modelId: string;
      /** The unsent composer text describing the task. */
      description: string;
      /** What the user typed into the worktree search, if anything. */
      hint?: string;
      /** Branch names already in the repository. */
      taken?: string[];
    };
    output: { branch: string };
  };
}
