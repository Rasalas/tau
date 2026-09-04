export const REVIEW_HOST_EXTENSION_ID = "tau.review";

export type CommitMessageStyle = "conventional" | "gitmoji" | "plain";

export interface CommitMessageDiffInput {
  path: string;
  patch: string;
}

export interface CommitMessageSuggestionInput {
  provider: string;
  modelId: string;
  style: CommitMessageStyle;
  branch?: string;
  files: Array<{ path: string; added: number; removed: number }>;
  diffs: CommitMessageDiffInput[];
}
