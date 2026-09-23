/**
 * Worktree Names' contract between its host entry and its desktop entry. The
 * desktop side picks the model and gathers the task; the host side asks the
 * model and answers with a branch name Git accepts.
 */
export const WORKTREE_NAMES_HOST_EXTENSION_ID = "tau.worktree-names";

/** Why nothing was asked: neither a task in the composer nor the start of a name. */
export const DESCRIBE_THE_TASK = "Describe the task in the composer first, or type the start of a name.";
