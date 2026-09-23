/** Where a remote URL points: `git@host:o/r.git`, `ssh://git@host:22/o/r`, `https://host/o/r.git`. */
export function parseRemote(url: string | undefined): { host: string; repo: string } | undefined {
  const value = url?.trim();
  if (!value) return undefined;
  let host: string | undefined;
  let path: string | undefined;
  const scp = /^(?:[^@/]+@)?([^:/]+):(?!\/)(.+)$/u.exec(value);
  if (scp && !/^[a-z]+:\/\//iu.test(value)) {
    [, host, path] = scp;
  } else {
    try {
      const parsed = new URL(value);
      host = parsed.hostname;
      path = parsed.pathname;
    } catch {
      return undefined;
    }
  }
  const repo = path?.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  // A host alias from ~/.ssh/config names no server the CLI knows.
  if (!host || !repo || !repo.includes("/") || !host.includes(".")) return undefined;
  return { host: host.toLowerCase(), repo };
}
