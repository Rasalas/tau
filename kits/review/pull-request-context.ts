import { useCallback } from "react";
import { useDiffContext, type DiffContext } from "tau";
import { providerInfo, type PullRequestDetail, type PullRequestFile } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";

/**
 * Lets a request's diffs show the unchanged lines around a change. The text
 * comes from the host at the request's head commit, so a new head starts
 * over; a deleted file has no head to read, and a host that cannot read
 * files, or named no head commit, offers nothing.
 */
export function usePullRequestContext(client: PullRequestClient, detail: PullRequestDetail, files: readonly Pick<PullRequestFile, "path" | "status">[]): DiffContext {
  const readable = providerInfo(detail.ref.service).capabilities.fileContents && Boolean(detail.headSha);
  const url = detail.ref.url;
  const read = useCallback(async (path: string) => (await client.file(url, path)).text, [client, url]);
  const can = useCallback((path: string) => readable && files.find((file) => file.path === path)?.status !== "deleted", [files, readable]);
  return useDiffContext({ read, can, scope: `${url}@${detail.headSha ?? ""}` });
}
