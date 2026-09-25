import { describe, expect, it } from "vitest";
import { parseGitLog, parseGitStatus } from "./server-git";
import { sshTerminalCommand } from "./ssh-terminal";
import { conflictsOf, deriveState, groupPending, uploadSummary, worstState } from "./status-model";
import { parseFileDiff, parseNameStatus } from "./history";
import type { PendingUploadRow } from "./view-protocol";

const rows: PendingUploadRow[] = [
  { path: "a.php", change: "modified", selected: true },
  { path: "b.php", change: "added", selected: true },
  { path: "old.php", change: "deleted", selected: true },
  { path: "gone.php", change: "deleted", selected: true },
  { path: "wp-config.php", change: "modified", selected: false, credentials: ["WordPress database settings"] },
];

describe("a target's state", () => {
  it("goes by what matters most: unusable, unreachable, never read, conflict, drift, pending, in sync", () => {
    const mirror = { commit: "c" };
    expect(deriveState({ usable: false, pending: [] })).toBe("unusable");
    expect(deriveState({ usable: true, unreachable: "refused", mirror, pending: [{ path: "a" }] })).toBe("unreachable");
    expect(deriveState({ usable: true, pending: [] })).toBe("never-read");
    expect(deriveState({ usable: true, mirror, pending: [{ path: "a" }], drift: [{ path: "a" }] })).toBe("conflict");
    expect(deriveState({ usable: true, mirror, pending: [{ path: "a" }], drift: [{ path: "b" }] })).toBe("drift");
    expect(deriveState({ usable: true, mirror, pending: [{ path: "a" }], drift: [] })).toBe("pending");
    expect(deriveState({ usable: true, mirror, pending: [] })).toBe("in-sync");
    expect(conflictsOf([{ path: "a" }, { path: "b" }], [{ path: "b" }])).toEqual(["b"]);
    expect(worstState(["in-sync", "pending", "drift"])).toBe("drift");
    expect(worstState([])).toBeUndefined();
  });

  it("names the upload by what goes up and what goes away, deletions counted on the button", () => {
    expect(groupPending(rows).deleted.map((row) => row.path)).toEqual(["old.php", "gone.php"]);
    expect(uploadSummary(rows)).toBe("Upload: 2 changed, 2 deleted");
    expect(uploadSummary(rows, (row) => row.change === "deleted")).toBe("Upload: 2 deleted");
    expect(uploadSummary(rows, () => false)).toBe("Upload");
  });
});

describe("the server's Git, read only", () => {
  it("reads the branch line and the entries of a porcelain status", () => {
    const output = ["## live...origin/live [ahead 1, behind 2]", " M about.php", "R  new.php", "old.php", "?? tmp.txt", ""].join("\0");
    expect(parseGitStatus(output)).toEqual({
      repository: true, branch: "live", upstream: "origin/live", ahead: 1, behind: 2, changed: 3,
      files: [{ path: "about.php", code: " M" }, { path: "new.php", code: "R " }, { path: "tmp.txt", code: "??" }],
    });
    expect(parseGitStatus("## No commits yet on main\0").branch).toBe("main");
  });

  it("reads the log records", () => {
    const sha = "a".repeat(40);
    expect(parseGitLog(`${sha}\x1fDev\x1f1700000000\x1fFix the header\x1e\n`)).toEqual([{ sha, author: "Dev", at: 1_700_000_000, subject: "Fix the header" }]);
  });
});

describe("the mirror's history and diffs", () => {
  it("reads name-status records and a one-file patch", () => {
    expect(parseNameStatus("M\0a.php\0A\0b c.php\0D\0gone.php\0")).toEqual([
      { path: "a.php", change: "modified" }, { path: "b c.php", change: "added" }, { path: "gone.php", change: "deleted" },
    ]);
    const diff = parseFileDiff("a.php", "diff --git a/x b/x\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n\\ No newline at end of file\n");
    expect(diff).toMatchObject({ added: 1, removed: 1 });
    expect(diff.hunks[0]!.lines).toEqual([
      { kind: "context", oldLine: 1, newLine: 1, text: "keep" },
      { kind: "removed", oldLine: 2, text: "old" },
      { kind: "added", newLine: 2, text: "new" },
    ]);
    expect(parseFileDiff("logo.png", "Binary files a/x and b/x differ\n").note).toMatch(/Binary/u);
  });
});

describe("the SSH terminal's command", () => {
  it("logs in over Tau's connection with the target's options and opens a shell in the server folder", () => {
    const command = sshTerminalCommand({
      ssh: "/usr/bin/ssh",
      target: { id: "t", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/site" },
      root: "/srv/it's here",
      controlDir: "/tmp/tau-501",
      env: { TAU_SERVERS_SSH_CONFIG: "/w/.tau-dev/servers/ssh_config" },
    });
    expect(command.startsWith("'/usr/bin/ssh' '-F' '/w/.tau-dev/servers/ssh_config' '-l' 'tester' '-p' '2222'")).toBe(true);
    expect(command).toContain("'ControlPath=/tmp/tau-501/%C'");
    expect(command).toContain("'-t' '--' '127.0.0.1'");
    expect(command.endsWith(`'cd '\\''/srv/it'\\''\\'\\'''\\''s here'\\'' && exec "$SHELL" -l'`)).toBe(true);
  });
});
