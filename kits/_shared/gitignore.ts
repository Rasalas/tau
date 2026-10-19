/** `.gitignore` rules as Git reads them, for the walkers that have no Git behind them (search, plain-folder snapshots). */

export interface IgnoreRule {
  /** The folder the `.gitignore` sits in, relative to the project; "" for the root. */
  base: string;
  pattern: RegExp;
  negate: boolean;
  directoryOnly: boolean;
  /** Matched against the path below `base`; otherwise against the name alone, at any depth. */
  anchored: boolean;
}

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
}

function globToRegex(glob: string): string {
  let out = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") { out += "(?:.*/)?"; index += 2; } else { out += ".*"; index += 1; }
    } else if (char === "*") {
      out += "[^/]*";
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "[" && glob.indexOf("]", index + 2) > index) {
      const close = glob.indexOf("]", index + 2);
      const body = glob.slice(index + 1, close);
      out += `[${body.startsWith("!") ? `^${body.slice(1)}` : body}]`;
      index = close;
    } else if (char === "\\" && index + 1 < glob.length) {
      out += escapeRegex(glob[index + 1]!);
      index += 1;
    } else {
      out += escapeRegex(char);
    }
  }
  return out;
}

export function parseGitignore(text: string, base = ""): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    let line = raw.replace(/(?<!\\)\s+$/u, "");
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const directoryOnly = line.endsWith("/");
    if (directoryOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    if (!line) continue;
    try {
      rules.push({ base, pattern: new RegExp(`^${globToRegex(line)}$`, "u"), negate, directoryOnly, anchored });
    } catch {
      // A pattern that makes no regular expression ignores nothing.
    }
  }
  return rules;
}

/** Later rules win, the way Git reads them: a deeper `.gitignore` after its parents'. */
export function isIgnored(rules: readonly IgnoreRule[], path: string, directory: boolean): boolean {
  let ignored = false;
  for (const rule of rules) {
    if (rule.directoryOnly && !directory) continue;
    const below = rule.base ? (path.startsWith(`${rule.base}/`) ? path.slice(rule.base.length + 1) : undefined) : path;
    if (below === undefined) continue;
    const subject = rule.anchored ? below : below.slice(below.lastIndexOf("/") + 1);
    if (rule.pattern.test(subject)) ignored = !rule.negate;
  }
  return ignored;
}
