/** `git diff --numstat -z`: renames have an empty path followed by old and new paths. */
export function parseNumstat(stdout: string): Map<string, { added: number; removed: number }> {
  const counts = new Map<string, { added: number; removed: number }>();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/su.exec(tokens[index] ?? "");
    if (!match) continue;
    let path = match[3];
    if (!path) {
      index += 2;
      path = tokens[index] ?? "";
      if (!path) continue;
    }
    counts.set(path, { added: Number(match[1]) || 0, removed: Number(match[2]) || 0 });
  }
  return counts;
}

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, "\\": 92, "\"": 34 };

/** The line form of Git's porcelain quotes paths using C escapes and octal UTF-8 bytes. */
export function unquoteGitPath(path: string): string {
  if (path.length < 2 || !path.startsWith("\"") || !path.endsWith("\"")) return path;
  const bytes: number[] = [];
  for (const [, octal, escaped, plain] of path.slice(1, -1).matchAll(/\\([0-7]{1,3})|\\([^0-7])|([^\\]+|\\)/gsu)) {
    if (octal) bytes.push(parseInt(octal, 8) & 0xff);
    else if (escaped) bytes.push(...(C_ESCAPES[escaped] !== undefined ? [C_ESCAPES[escaped]!] : Buffer.from(`\\${escaped}`)));
    else bytes.push(...Buffer.from(plain!));
  }
  return Buffer.from(bytes).toString("utf8");
}
