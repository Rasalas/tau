import type { PullRequestDetail } from "./protocol.js";

export const canSetMaintainerEdits = (detail: PullRequestDetail): boolean => detail.ref.service === "github" && detail.state === "open"
  && Boolean(detail.headRepository && detail.headRepository.toLowerCase() !== detail.ref.repo.toLowerCase())
  && detail.viewerCanUpdate === true && detail.viewerCanAllowMaintainerEdits === true && typeof detail.maintainerCanModify === "boolean";

