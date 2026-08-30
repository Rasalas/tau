/** `/Users/me/work/tau` → `~/work/tau`. Display only; the real path is kept for titles. */
export function displayPath(value: string): string {
  return value.replace(/^\/(?:Users|home)\/[^/]+/u, "~");
}

/**
 * macOS-style elision: keeps the root and as many of the deepest folders as fit,
 * so the part you actually read — where it ends — survives.
 */
export function shortenPath(value: string, max = 36): string {
  const shown = displayPath(value);
  if (shown.length <= max) return shown;

  const parts = shown.split("/");
  const head = parts[0];
  const rest = parts.slice(1).filter(Boolean);
  if (rest.length <= 1) return shown;

  let kept = rest.slice(-1);
  for (let index = rest.length - 2; index >= 0; index -= 1) {
    const candidate = [head, "…", ...rest.slice(index)].join("/");
    if (candidate.length > max) break;
    kept = rest.slice(index);
  }
  return [head, "…", ...kept].join("/");
}
