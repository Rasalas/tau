/**
 * `/`, or a Windows drive or share root. An app opened from the Finder runs
 * in `/`, which is never a project anybody chose.
 */
export function isFilesystemRoot(path: string): boolean {
  return /^(?:\/+|[A-Za-z]:[\\/]*|[\\/]{2}[^\\/]+[\\/]+[^\\/]+[\\/]*)$/u.test(path);
}
