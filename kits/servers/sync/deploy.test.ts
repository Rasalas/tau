import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { planSummary } from "../deploy-protocol";
import { FolderServerFs } from "../fixtures/fake-server-fs";
import { heldBy, supersededPaths } from "../journal";
import { SFTP_STATUS, SftpError } from "../sftp-client";
import { applyIntents, inspectIntents, threeWay, writeServerFile } from "./deploy";
import { hasConflictMarkers } from "./local";
import { blobId } from "./mirror";

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
    // A file a later deployment wrote again is that deployment's to hold.
    expect(heldBy(record, new Map([["site/a.php", "3".repeat(40)]]), new Set(["a.php"]))).toBe(true);
    const records = [1, 2, 3].map((seq) => ({ seq, files: seq === 2 ? [] : [{ path: "a.php", op: "modify" }] })) as unknown as Parameters<typeof supersededPaths>[1];
    expect([...supersededPaths({ seq: 1 }, records)]).toEqual(["a.php"]);
    expect([...supersededPaths({ seq: 3 }, records)]).toEqual([]);
  });
});

describe("failed server uploads", () => {
  const roots: string[] = [];
  const before = Buffer.from("<?php production();\n");
  const after = Buffer.from("<?php replacement();\n");
  const options = { mode: 0o640, existing: true, dirMode: 0o750 };
  const setup = (atomicRename = true) => {
    const root = mkdtempSync(join(tmpdir(), "tau-upload-failure-"));
    roots.push(root);
    writeFileSync(join(root, "config.php"), before, { mode: options.mode });
    return new FolderServerFs(root, { writable: true, atomicRename });
  };
  const expectUntouched = (fs: FolderServerFs) => {
    expect(readFileSync(join(fs.root, "config.php"))).toEqual(before);
    expect(readdirSync(fs.root)).toEqual(["config.php"]);
  };
  afterEach(() => {
    vi.restoreAllMocks();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("leaves the live file intact and removes a partial temp upload on a full disk", async () => {
    const fs = setup();
    vi.spyOn(fs, "write").mockImplementation(async (path) => {
      writeFileSync(join(fs.root, path), Buffer.alloc(0));
      throw new SftpError(SFTP_STATUS.FAILURE, "No space left on device", path);
    });
    const inspected = await inspectIntents(fs, [{ path: "config.php", op: "modify", content: after, newMode: options.mode, expect: blobId(before) }]);
    const result = await applyIntents(fs, inspected, options);
    expect(result.failed).toEqual([{ path: "config.php", op: "modify", message: expect.stringContaining("No space left on device") }]);
    expect(result.applied).toEqual([]);
    expectUntouched(fs);
    expect(fs.write).toHaveBeenCalledTimes(1);
  });

  it("does not fall back when a full disk prevents even creating the temp file", async () => {
    const fs = setup();
    vi.spyOn(fs, "write").mockRejectedValue(new SftpError(SFTP_STATUS.FAILURE, "Quota exceeded"));
    await expect(writeServerFile(fs, "config.php", after, options)).rejects.toThrow("Quota exceeded");
    expectUntouched(fs);
    expect(fs.write).toHaveBeenCalledTimes(1);
  });

  it("checks a short temp upload before replacing the live file", async () => {
    const fs = setup();
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementation((path, data, call) => write(path, data.subarray(0, 2), call));
    await expect(writeServerFile(fs, "config.php", after, options)).rejects.toThrow("2 bytes");
    expectUntouched(fs);
    expect(fs.calls.some((call) => call.startsWith("rename"))).toBe(false);
  });

  it.each(["chmod", "rename"] as const)("does not fall back when %s fails after creating the temp file", async (operation) => {
    const fs = setup();
    vi.spyOn(fs, operation).mockRejectedValue(new SftpError(SFTP_STATUS.PERMISSION_DENIED, "Permission denied"));
    await expect(writeServerFile(fs, "config.php", after, options)).rejects.toThrow("Permission denied");
    expectUntouched(fs);
    expect(fs.calls.filter((call) => call.startsWith("write"))).toHaveLength(1);
  });

  it.each([true, false])("restores the backup after an in-place write fails, atomic rename available: %s", async (atomicRename) => {
    const fs = setup(atomicRename);
    if (atomicRename) fs.denyEntries.add("");
    const write = fs.write.bind(fs);
    let failed = false;
    vi.spyOn(fs, "write").mockImplementation(async (path, data, call) => {
      if (path === "config.php" && !failed) {
        failed = true;
        await write(path, Buffer.alloc(0), call);
        throw new SftpError(SFTP_STATUS.FAILURE, "No space left on device");
      }
      await write(path, data, call);
    });
    await expect(writeServerFile(fs, "config.php", after, options)).rejects.toThrow("No space left on device");
    expectUntouched(fs);
  });

  it("restores the backup when an in-place upload is short", async () => {
    const fs = setup(false);
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementationOnce((path, data, call) => write(path, data.subarray(0, 2), call));
    await expect(writeServerFile(fs, "config.php", after, options)).rejects.toThrow("2 bytes");
    expectUntouched(fs);
  });

  it("restores the backup without the cancelled upload's signal", async () => {
    const fs = setup(false);
    const controller = new AbortController();
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementationOnce(async (path, _data, call) => {
      await write(path, Buffer.alloc(0), call);
      controller.abort();
      throw new DOMException("The upload was stopped.", "AbortError");
    });
    await expect(writeServerFile(fs, "config.php", after, { ...options, signal: controller.signal })).rejects.toThrow("stopped");
    expectUntouched(fs);
    expect(fs.write).toHaveBeenLastCalledWith("config.php", before, expect.not.objectContaining({ signal: controller.signal }));
  });

  it("removes a partial temp upload even after cancellation", async () => {
    const fs = setup();
    const controller = new AbortController();
    const write = fs.write.bind(fs);
    vi.spyOn(fs, "write").mockImplementationOnce(async (path, _data, call) => {
      await write(path, Buffer.alloc(0), call);
      controller.abort();
      throw new DOMException("The upload was stopped.", "AbortError");
    });
    const remove = vi.spyOn(fs, "remove");
    await expect(writeServerFile(fs, "config.php", after, { ...options, signal: controller.signal })).rejects.toThrow("stopped");
    expectUntouched(fs);
    expect(remove).toHaveBeenCalledWith(expect.stringMatching(/^\.config\.php\.tau-/u), { area: "project" });
  });

  it("reports both the upload error and a failed restoration", async () => {
    const fs = setup(false);
    vi.spyOn(fs, "write").mockRejectedValueOnce(new Error("Quota exceeded")).mockRejectedValueOnce(new Error("Still full"));
    await expect(writeServerFile(fs, "config.php", after, options)).rejects.toThrow("Quota exceeded Could not restore config.php: Still full");
  });

  it("stops the deployment on a lost connection even if temp cleanup also fails", async () => {
    const fs = setup();
    writeFileSync(join(fs.root, "second.php"), before);
    const inspected = await inspectIntents(fs, ["config.php", "second.php"].map((path) => ({ path, op: "modify", content: after, newMode: options.mode, expect: blobId(before) })));
    vi.spyOn(fs, "write").mockRejectedValue(new SftpError(SFTP_STATUS.CONNECTION_LOST, "Connection lost"));
    vi.spyOn(fs, "remove").mockRejectedValue(new SftpError(SFTP_STATUS.NO_CONNECTION, "No connection"));
    const result = await applyIntents(fs, inspected, options);
    expect(result.failed).toEqual([
      { path: "config.php", op: "modify", message: expect.stringContaining("Could not remove temporary file") },
      { path: "second.php", op: "modify", message: "Not tried: the connection to the server was lost." },
    ]);
    expect(fs.write).toHaveBeenCalledTimes(1);
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
