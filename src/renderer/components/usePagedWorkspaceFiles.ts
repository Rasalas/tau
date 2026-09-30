import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "../../workbench/error-message";
import type { UiChangedFile, UiWorkspaceChanges, UiWorkspaceChangesPage } from "../../shared/workspace-kit-types";

/**
 * One paging state machine is shared by the transcript card and historical
 * review. The cursor is owned by the immutable source, so neither renderer can
 * accidentally invent a different page size or skip files.
 */
export function usePagedWorkspaceFiles(
  changes: UiWorkspaceChanges,
  loadFiles?: (cursor?: string, limit?: number) => Promise<UiWorkspaceChangesPage>,
) {
  const fileCount = changes.fileCount ?? changes.files.length;
  const previewCursor = useMemo(
    () => (fileCount > changes.files.length ? String(changes.files.length) : undefined),
    [changes.files.length, fileCount],
  );
  const [files, setFiles] = useState<UiChangedFile[]>(changes.files);
  const [nextCursor, setNextCursor] = useState<string | undefined>(previewCursor);
  const [hasMore, setHasMore] = useState(() => Boolean(previewCursor));
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setFiles(changes.files);
    setNextCursor(previewCursor);
    setHasMore(Boolean(previewCursor));
    setError(undefined);
  }, [changes.files, previewCursor]);

  const loadNextPage = async (): Promise<void> => {
    if (!loadFiles || loading || !hasMore) return;
    setLoading(true);
    setError(undefined);
    try {
      const page = await loadFiles(nextCursor, 40);
      setFiles((current) => {
        const known = new Set(current.map((file) => file.path));
        return [...current, ...page.files.filter((file) => !known.has(file.path))];
      });
      setNextCursor(page.nextCursor);
      setHasMore(page.hasMore);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  };

  return { files, fileCount, hasMore, loading, error, loadNextPage };
}
