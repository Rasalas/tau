/** A filesystem link, resolved only by the thread's host, never by the client. */
export function linkedFilePath(path: string): string {
  if (!path || !path.trim() || path.includes("\0") || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(path) && !/^[A-Za-z]:[/\\]/u.test(path)) {
    throw new Error("Name a file by a filesystem path on the thread's machine.");
  }
  return path.replace(/\\/gu, "/").replace(/^\.\//u, "");
}
