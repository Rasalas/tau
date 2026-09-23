/**
 * A host path relative to a root the same host named, POSIX-style, or
 * undefined outside it. The window cannot know the host's platform, so a
 * backslash counts as a separator too.
 */
export function relativeHostPath(path: string | undefined, root: string | undefined): string | undefined {
  if (!path || !root || !path.startsWith(root)) return undefined;
  const rest = path.slice(root.length);
  if (!/^[/\\]./u.test(rest)) return undefined;
  return rest.slice(1).replaceAll("\\", "/");
}
