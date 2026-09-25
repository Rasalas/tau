import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { planSummary } from "../deploy-protocol";
import { FolderServerFs } from "../fixtures/fake-server-fs";
import { heldBy } from "../journal";
import { threeWay, writeServerFile } from "./deploy";
import { hasConflictMarkers } from "./local";

describe("the upload's three-way decision", () => {
  it("uploads over the base, skips what is there, and stops at anything else", () => {
    expect(threeWay("base", "base", "ours")).toBe("apply");
    expect(threeWay("base", "ours", "ours")).toBe("same");
    expect(threeWay("base", "theirs", "ours")).toBe("conflict");
    // A new file: nothing was there and nothing is.
    expect(threeWay(null, null, "ours")).toBe("apply");
    expect(threeWay(null, "theirs", "ours")).toBe("conflict");
    // A deletion: gone already, still the base, or changed.
    expect(threeWay("base", null, null)).toBe("same");
    expect(threeWay("base", "base", null)).toBe("apply");
    expect(threeWay("base", "theirs", null)).toBe("conflict");
  });

  it("finds the markers git merge-file leaves, not a line of equals signs alone", () => {
    expect(hasConflictMarkers(Buffer.from("a\n<<<<<<< local\nb\n=======\nc\n>>>>>>> server\n"))).toBe(true);
    expect(hasConflictMarkers(Buffer.from("Title\n=======\n"))).toBe(false);
    expect(hasConflictMarkers(Buffer.from("<<<<<<< a\n=======\n>>>>>>> b\n\0binary"))).toBe(false);
  });

  it("counts what a plan writes for the confirm button", () => {
    expect(planSummary([
      { op: "modify", outcome: "upload" }, { op: "add", outcome: "upload" }, { op: "delete", outcome: "delete" },
      { op: "modify", outcome: "conflict" }, { op: "modify", outcome: "conflict", forced: true }, { op: "modify", outcome: "same" },
    ])).toEqual({ changed: 3, deleted: 1, label: "Upload: 3 changed, 1 deleted" });
    expect(planSummary([{ op: "modify", outcome: "blocked" }]).label).toBe("Upload");
  });

  it("says a commit holds a deployment when every file has the blob that went up and every deletion is gone", () => {
    const record = { context: "site", files: [{ path: "a.php", op: "modify" as const, after: "1".repeat(40) }, { path: "b.php", op: "delete" as const }] };
    expect(heldBy(record, new Map([["site/a.php", "1".repeat(40)]]))).toBe(true);
    expect(heldBy(record, new Map([["site/a.php", "1".repeat(40)], ["site/b.php", "2".repeat(40)]]))).toBe(false);
    expect(heldBy(record, new Map([["site/a.php", "3".repeat(40)]]))).toBe(false);
    expect(heldBy({ context: "", files: [] }, new Map())).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("writing a file on the server", () => {
  it("creates missing folders with dirPerm and the file with its mode, through a temp file", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-write-"));
    try {
      const fs = new FolderServerFs(root, { writable: true });
      const written = await writeServerFile(fs, "a/b/new.php", Buffer.from("<?php\n"), { mode: 0o640, existing: false, dirMode: 0o750 });
      expect(written.via).toBe("rename");
      expect(statSync(join(root, "a")).mode & 0o777).toBe(0o750);
      expect(statSync(join(root, "a", "b")).mode & 0o777).toBe(0o750);
      expect(statSync(join(root, "a", "b", "new.php")).mode & 0o777).toBe(0o640);
      expect(fs.calls.filter((call) => call.startsWith("rename"))[0]).toMatch(/^rename a\/b\/\.new\.php\.tau-[0-9a-f]{8} a\/b\/new\.php$/u);
      // A file where a folder should be stops it.
      writeFileSync(join(root, "c"), "x");
      await expect(writeServerFile(fs, "c/d.php", Buffer.from("x"), { mode: 0o644, existing: false, dirMode: 0o755 })).rejects.toThrow("c is a file on the server, not a folder.");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
