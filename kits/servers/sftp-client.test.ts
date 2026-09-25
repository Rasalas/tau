import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough, type Readable, type Writable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findSftpServer } from "./fixtures/fake-ssh-server.mjs";
import { fileType, isNoSuchFile, SftpClient, SftpError, SFTP_STATUS } from "./sftp-client";

const sftpServer = findSftpServer();

describe.skipIf(!sftpServer)("SftpClient against the machine's sftp-server", () => {
  let dir: string;
  let child: ChildProcessByStdio<Writable, Readable, Readable>;
  let client: SftpClient;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "tau-sftp-client-")));
    child = spawn(sftpServer!, ["-e", "-d", dir], { stdio: ["pipe", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: dir } });
    child.stderr.resume();
    client = new SftpClient(child.stdout, child.stdin, { concurrency: 8, chunkSize: 4096 });
    await client.init();
  });

  afterAll(() => {
    client?.end();
    if (child?.exitCode === null) child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  it("speaks version 3 and sees OpenSSH's extensions", () => {
    expect(client.version).toBe(3);
    expect(client.hasPosixRename).toBe(true);
  });

  it("writes and reads a file bigger than the chunk, pipelined", async () => {
    const data = randomBytes(4096 * 20 + 123);
    await client.writeFile(join(dir, "big.bin"), data, { mode: 0o640 });
    expect(readFileSync(join(dir, "big.bin")).equals(data)).toBe(true);
    expect(statSync(join(dir, "big.bin")).mode & 0o777).toBe(0o640);
    const back = await client.readFile(join(dir, "big.bin"));
    expect(back.equals(data)).toBe(true);
  });

  it("reads an empty file and a file of exactly one chunk", async () => {
    writeFileSync(join(dir, "empty"), "");
    writeFileSync(join(dir, "one"), Buffer.alloc(4096, 7));
    expect((await client.readFile(join(dir, "empty"))).length).toBe(0);
    expect((await client.readFile(join(dir, "one"))).equals(Buffer.alloc(4096, 7))).toBe(true);
  });

  it("stats, lstats, fstats and sets attributes", async () => {
    writeFileSync(join(dir, "stat.txt"), "hello");
    symlinkSync(join(dir, "stat.txt"), join(dir, "link"));
    const attrs = await client.stat(join(dir, "stat.txt"));
    expect(attrs.size).toBe(5);
    expect(fileType(attrs.mode)).toBe("file");
    expect(fileType((await client.lstat(join(dir, "link"))).mode)).toBe("symlink");
    expect(fileType((await client.stat(join(dir, "link"))).mode)).toBe("file");
    await client.setstat(join(dir, "stat.txt"), { mode: 0o600, atime: 1_600_000_000, mtime: 1_600_000_000 });
    const after = statSync(join(dir, "stat.txt"));
    expect(after.mode & 0o777).toBe(0o600);
    expect(Math.floor(after.mtimeMs / 1000)).toBe(1_600_000_000);
    const handle = await client.open(join(dir, "stat.txt"), 1);
    expect((await client.fstat(handle)).size).toBe(5);
    await client.close(handle);
  });

  it("makes, lists and removes directories", async () => {
    await client.mkdir(join(dir, "sub"), { mode: 0o755 });
    writeFileSync(join(dir, "sub", "a"), "a");
    writeFileSync(join(dir, "sub", "b"), "b");
    const names = (await client.list(join(dir, "sub"))).map((entry) => entry.filename).sort();
    expect(names).toEqual(["a", "b"]);
    await client.remove(join(dir, "sub", "a"));
    await client.remove(join(dir, "sub", "b"));
    await client.rmdir(join(dir, "sub"));
    await expect(client.stat(join(dir, "sub"))).rejects.toSatisfy(isNoSuchFile);
  });

  it("resolves real paths, relative to the start folder too", async () => {
    mkdirSync(join(dir, "real"), { recursive: true });
    expect(await client.realpath(join(dir, "real", "..", "real"))).toBe(join(dir, "real"));
    expect(await client.realpath(".")).toBe(dir);
  });

  it("renames: plain RENAME refuses an existing target, posix-rename replaces it", async () => {
    writeFileSync(join(dir, "from"), "new");
    writeFileSync(join(dir, "to"), "old");
    await expect(client.rename(join(dir, "from"), join(dir, "to"))).rejects.toBeInstanceOf(SftpError);
    await client.posixRename(join(dir, "from"), join(dir, "to"));
    expect(readFileSync(join(dir, "to"), "utf8")).toBe("new");
    await client.rename(join(dir, "to"), join(dir, "moved"));
    expect(readFileSync(join(dir, "moved"), "utf8")).toBe("new");
  });

  it("reports a missing file as NO_SUCH_FILE with its path", async () => {
    const error = await client.readFile(join(dir, "missing")).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SftpError);
    expect((error as SftpError).code).toBe(SFTP_STATUS.NO_SUCH_FILE);
    expect((error as SftpError).message).toContain("missing");
  });

  it("stops a read when its signal aborts and the session stays usable", async () => {
    writeFileSync(join(dir, "abort.bin"), randomBytes(4096 * 50));
    const controller = new AbortController();
    const reading = client.readFile(join(dir, "abort.bin"), controller.signal);
    controller.abort();
    await expect(reading).rejects.toThrow(/abort/iu);
    expect((await client.stat(join(dir, "abort.bin"))).size).toBe(4096 * 50);
  });

  it("refuses an exclusive create over an existing file", async () => {
    writeFileSync(join(dir, "exists"), "x");
    await expect(client.writeFile(join(dir, "exists"), Buffer.from("y"), { exclusive: true })).rejects.toBeInstanceOf(SftpError);
    expect(readFileSync(join(dir, "exists"), "utf8")).toBe("x");
  });
});

describe("SftpClient framing", () => {
  it("fails every waiting request when the stream ends", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const client = new SftpClient(fromServer, toServer);
    const waiting = client.stat("/x");
    fromServer.end();
    await expect(waiting).rejects.toThrow(/ended/u);
    await expect(client.stat("/y")).rejects.toThrow(/ended/u);
  });

  it("reassembles packets split across chunks and drops replies nobody waits for", async () => {
    const fromServer = new PassThrough();
    const toServer = new PassThrough();
    const client = new SftpClient(fromServer, toServer);
    const version = Buffer.from([0, 0, 0, 5, 2, 0, 0, 0, 3]);
    const initializing = client.init();
    fromServer.write(version.subarray(0, 3));
    fromServer.write(version.subarray(3));
    await initializing;
    expect(client.version).toBe(3);
    const statting = client.stat("/x");
    // A stray STATUS for id 99, then ATTRS (size 7) for id 1.
    const stray = Buffer.from([0, 0, 0, 13, 101, 0, 0, 0, 99, 0, 0, 0, 0, 0, 0, 0, 0]);
    const attrs = Buffer.from([0, 0, 0, 17, 105, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 7]);
    fromServer.write(Buffer.concat([stray, attrs]).subarray(0, 10));
    fromServer.write(Buffer.concat([stray, attrs]).subarray(10));
    expect(await statting).toEqual({ size: 7 });
  });
});
