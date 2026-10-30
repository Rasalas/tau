import type { PullRequestFiles } from "./protocol.js";

export function interactionFiles(): PullRequestFiles {
  const paths = ["src/a.ts", "src/a.test.ts", "src/c.ts", "src/d.ts"];
  return {
    files: paths.map((path) => ({ path, status: "modified", viewed: "unviewed", added: 1, removed: 0 })),
    diffs: paths.map((path) => ({ path, added: 1, removed: 0, hunks: [{ header: "@@ -0,0 +1 @@", lines: [
      { kind: "added", newLine: 1, text: path.endsWith(".test.ts") ? "testOnlyNeedle" : `source ${path}` },
    ] }] })),
    viewedOn: "host",
  };
}
