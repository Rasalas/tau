import { X509Certificate } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client, FileInfo, FileType } from "basic-ftp";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startFtpCli, stopFtpCli, type RunningFtp } from "./fixtures/fake-ftp-cli";
import { hasCommand } from "./fixtures/run-command";
import { paths, prepareServersDir, readCalls } from "./fixtures/servers-test-env.mjs";
import { ServerPathError, type ServerFs } from "./server-fs";
import { isNoSuchFile, SFTP_STATUS, SftpError } from "./sftp-client";
import { writeServerFile } from "./sync/deploy";
import { FtpConnectError, FtpTransport, parseListTime, statOfInfo, type FtpCertificate, type FtpTarget } from "./transport-ftp";

const ready = process.platform !== "win32" && process.getuid?.() !== 0;
const hasOpenssl = hasCommand("openssl", ["version"]);

function put(root: string, path: string, content: string, mode?: number) {
  const file = join(root, ...path.split("/"));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  if (mode !== undefined) chmodSync(file, mode);
}

/** A login that answers from a list and counts what the transport reported back. */
function logins(answers: (string | undefined)[]) {
  const count = { asked: 0, accepted: 0, rejected: 0 };
  let next = 0;
  return {
    count,
    attempt: () => ({
      secret: async () => { count.asked += 1; return answers[Math.min(next++, answers.length - 1)]; },
      accepted: async () => { count.accepted += 1; },
      rejected: async () => { count.rejected += 1; },
    }),
  };
}

describe("FTP listings", () => {
  const now = new Date(2026, 8, 25, 12, 0);

  it("reads LIST times as local wall time, less the offset", () => {
    expect(parseListTime("Sep 25 11:13", 0, now)).toBe(new Date(2026, 8, 25, 11, 13).getTime() / 1000);
    expect(parseListTime("Sep 25 11:13", 2, now)).toBe(new Date(2026, 8, 25, 9, 13).getTime() / 1000);
    // No year and later than now: last year's.
    expect(parseListTime("Dec 24 08:00", 0, now)).toBe(new Date(2025, 11, 24, 8, 0).getTime() / 1000);
    expect(parseListTime("Mar  3  2024", 0, now)).toBe(new Date(2024, 2, 3).getTime() / 1000);
    expect(parseListTime("2026-09-25 07:05", 0, now)).toBe(new Date(2026, 8, 25, 7, 5).getTime() / 1000);
    expect(parseListTime("09-25-26 01:05PM", 0, now)).toBe(new Date(2026, 8, 25, 13, 5).getTime() / 1000);
    expect(parseListTime("yesterday", 0, now)).toBe(0);
  });

  it("takes modes from the permissions and MLSD times as UTC", () => {
    const listed = new FileInfo("index.php");
    listed.type = FileType.File;
    listed.size = 12;
    listed.permissions = { user: 6, group: 4, world: 0 };
    listed.rawModifiedAt = "Sep 25 11:13";
    expect(statOfInfo(listed, 1, now)).toEqual({ type: "file", size: 12, mode: 0o640, mtime: new Date(2026, 8, 25, 10, 13).getTime() / 1000 });
    const machine = new FileInfo("css");
    machine.type = FileType.Directory;
    machine.modifiedAt = new Date(Date.UTC(2026, 8, 25, 10, 0, 7));
    expect(statOfInfo(machine, 5, now)).toMatchObject({ type: "directory", size: 0, mode: 0o755, mtime: Date.UTC(2026, 8, 25, 10, 0, 7) / 1000 });
  });
});

describe.skipIf(!ready)("the FTP transport against the fake server", () => {
  let dir: string;
  let site: string;
  let running: RunningFtp | undefined;
  const open: FtpTransport[] = [];

  const transport = (target: Partial<FtpTarget>, options: { answers?: (string | undefined)[]; plain?: boolean; trust?: (certificate: FtpCertificate) => boolean; env?: NodeJS.ProcessEnv; lookup?: (host: string) => Promise<string[]> } = {}) => {
    const login = logins(options.answers ?? ["test"]);
    const asked = { plain: 0, certificates: [] as FtpCertificate[] };
    const fs = new FtpTransport({
      id: "site", host: "127.0.0.1", port: running?.port ?? 21, username: "tester", remotePath: "/site", secure: false,
      connectTimeout: 10_000, concurrency: 1, name: "site", ...target,
    }, {
      attempt: login.attempt,
      allowPlain: async () => { asked.plain += 1; return options.plain ?? true; },
      trustCertificate: async (certificate) => { asked.certificates.push(certificate); return options.trust?.(certificate) ?? true; },
      env: options.env ?? {},
      ...(options.lookup ? { lookup: options.lookup } : {}),
    });
    open.push(fs);
    return { fs, login, asked };
  };

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "tau-ftp-t-"));
    prepareServersDir(dir);
    site = realpathSync(join(paths(dir).root, "site"));
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((fs) => fs.close()));
    await stopFtpCli(running);
    running = undefined;
    if (existsSync(join(site, "locked"))) chmodSync(join(site, "locked"), 0o755);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const commands = () => readCalls(dir).filter((entry) => entry.tool === "ftp" && entry.event === "command");

  it("asks before plain FTP and sends nothing when the user says no", async () => {
    running = await startFtpCli(dir, ["--mode", "plain"]);
    const before = commands().length;
    const { fs, asked, login } = transport({}, { plain: false });
    await expect(fs.connect()).rejects.toBeInstanceOf(FtpConnectError);
    expect(asked.plain).toBe(1);
    expect(login.count.asked).toBe(0);
    expect(commands().slice(before)).toEqual([]);
  }, 30_000);

  it("lists, reads, uploads through a temp file and RNTO, and keeps the mode", async () => {
    put(site, "index.php", "<?php echo 'home';\n", 0o640);
    put(site, "sub dir/-dash [x].txt", "odd name\n");
    running = await startFtpCli(dir, ["--mode", "plain"]);
    const { fs, login } = transport({});
    await fs.connect();
    expect(login.count).toEqual({ asked: 1, accepted: 1, rejected: 0 });
    expect(fs.caps).toMatchObject({ exec: false, hash: false, atomicRename: true, chmod: true });
    expect((fs as ServerFs).exec).toBeUndefined();
    expect(fs.root).toBe("/site");

    const listing = await fs.list("");
    expect(listing.find((entry) => entry.name === "index.php")).toMatchObject({ type: "file", size: 19, mode: 0o640, path: "/site/index.php" });
    expect(listing.find((entry) => entry.name === "sub dir")).toMatchObject({ type: "directory" });
    expect((await fs.list("sub dir")).map((entry) => entry.name)).toEqual(["-dash [x].txt"]);
    expect((await fs.read("sub dir/-dash [x].txt")).toString()).toBe("odd name\n");

    const stat = await fs.stat("index.php");
    const written = await writeServerFile(fs, "index.php", Buffer.from("<?php echo 'new';\n"), { mode: stat.mode, existing: true, dirMode: 0o755 });
    expect(written.via).toBe("rename");
    expect(readFileSync(join(site, "index.php"), "utf8")).toBe("<?php echo 'new';\n");
    expect(statSync(join(site, "index.php")).mode & 0o777).toBe(0o640);
    expect(readdirSync(site).filter((name) => name.includes(".tau-"))).toEqual([]);
    const renames = commands().filter((entry) => entry.directive === "RNFR" || entry.directive === "RNTO").map((entry) => `${entry.directive} ${entry.arg}`);
    expect(renames.at(-2)).toMatch(/^RNFR \/site\/\.index\.php\.tau-[0-9a-f]{8}$/u);
    expect(renames.at(-1)).toBe("RNTO /site/index.php");

    const created = await writeServerFile(fs, "pages/new/pricing.php", Buffer.from("price\n"), { mode: 0o644, existing: false, dirMode: 0o750 });
    expect(created.stat).toMatchObject({ type: "file", size: 6 });
    expect(statSync(join(site, "pages", "new")).mode & 0o777).toBe(0o750);
    await expect(fs.write("pages/new/pricing.php", Buffer.from("x"), { exclusive: true })).rejects.toThrow("File exists");
    await fs.remove("pages/new/pricing.php");
    await fs.rmdir("pages/new");
    expect(existsSync(join(site, "pages", "new"))).toBe(false);
    await expect(fs.stat("pages/new/pricing.php")).rejects.toSatisfy(isNoSuchFile);
    await expect(fs.read("missing.php")).rejects.toSatisfy(isNoSuchFile);
    await expect(fs.remove("missing.php")).rejects.toSatisfy(isNoSuchFile);
    const empty = await writeServerFile(fs, "empty.txt", Buffer.alloc(0), { mode: 0o644, existing: false, dirMode: 0o755 });
    expect(empty.stat.size).toBe(0);
  }, 60_000);

  it("keeps to remotePath, never touches .git and does not follow links", async () => {
    put(dir, "root/outside.txt", "outside\n");
    put(site, ".git/config", "[core]\n");
    if (!existsSync(join(site, "escape"))) symlinkSync(join(paths(dir).root), join(site, "escape"));
    running = await startFtpCli(dir, ["--mode", "plain"]);
    const { fs } = transport({});
    await expect(fs.read("../outside.txt")).rejects.toBeInstanceOf(ServerPathError);
    await expect(fs.read("/outside.txt")).rejects.toBeInstanceOf(ServerPathError);
    await expect(fs.read(".git/config")).rejects.toBeInstanceOf(ServerPathError);
    await expect(fs.remove("")).rejects.toBeInstanceOf(ServerPathError);
    await expect(fs.read("bad\r\nDELE index.php")).rejects.toBeInstanceOf(ServerPathError);
    // ftp-srv lists a link as what it points to; most Unix servers show it as `l`, as here.
    const cwd = new WeakMap<Client, string>();
    const cd = Client.prototype.cd;
    const list = Client.prototype.list;
    const cdSpy = vi.spyOn(Client.prototype, "cd").mockImplementation(async function (this: Client, path: string) { cwd.set(this, path); return cd.call(this, path); });
    const listSpy = vi.spyOn(Client.prototype, "list").mockImplementation(async function (this: Client, path?: string) {
      const entries = await list.call(this, path);
      if (cwd.get(this) !== "/site") return entries;
      const link = new FileInfo("escape");
      link.type = FileType.SymbolicLink;
      link.link = "..";
      return [...entries.filter((entry) => entry.name !== "escape"), link];
    });
    try {
      await expect(fs.read("escape/outside.txt")).rejects.toThrow("link");
      await expect(fs.write("escape/new.txt", Buffer.from("x"))).rejects.toThrow("link");
      await expect(fs.read("escape")).rejects.toThrow("link");
      expect((await fs.list("")).find((entry) => entry.name === "escape")?.type).toBe("symlink");
    } finally {
      cdSpy.mockRestore();
      listSpy.mockRestore();
    }
    expect(existsSync(join(paths(dir).root, "new.txt"))).toBe(false);
    expect(commands().some((entry) => String(entry.arg ?? "").includes("outside") || String(entry.arg ?? "").includes("escape"))).toBe(false);
  }, 60_000);

  it("reports a folder the server will not list as refused, not as missing", async () => {
    put(site, "locked/secret.txt", "s\n");
    chmodSync(join(site, "locked"), 0o000);
    running = await startFtpCli(dir, ["--mode", "plain"]);
    const { fs } = transport({});
    const refused = await fs.list("locked").then(() => undefined, (error: unknown) => error);
    expect(refused).toBeInstanceOf(SftpError);
    // Any SFTP-style refusal but "absent" and "connection gone" marks the folder unreadable in a scan.
    expect([SFTP_STATUS.NO_SUCH_FILE, SFTP_STATUS.NO_CONNECTION, SFTP_STATUS.CONNECTION_LOST]).not.toContain((refused as SftpError).code);
    await expect(fs.list("nowhere")).rejects.toSatisfy(isNoSuchFile);
  }, 30_000);

  it("asks for the password again after a refusal, then gives up after three", async () => {
    running = await startFtpCli(dir, ["--mode", "plain"]);
    const retry = transport({}, { answers: ["wrong", "test"] });
    await retry.fs.connect();
    expect(retry.login.count).toEqual({ asked: 2, accepted: 1, rejected: 0 });
    const wrong = transport({}, { answers: ["nope"] });
    await expect(wrong.fs.connect()).rejects.toThrow("did not accept the password");
    expect(wrong.login.count).toEqual({ asked: 3, accepted: 0, rejected: 1 });
    const cancelled = transport({}, { answers: [undefined] });
    await expect(cancelled.fs.connect()).rejects.toThrow("cancelled");
  }, 60_000);

  it("refuses a server off loopback in a test instance before connecting", async () => {
    const guard = { TAU_SERVERS_LOOPBACK_ONLY: "1" };
    await expect(transport({ host: "192.0.2.1" }, { env: guard }).fs.connect()).rejects.toThrow("loopback only");
    await expect(transport({ host: "ftp.example.com" }, { env: guard, lookup: async () => ["127.0.0.1", "203.0.113.9"] }).fs.connect()).rejects.toThrow("203.0.113.9");
  });

  it("spreads work over connectionLimit connections, logging in once per connection", async () => {
    for (let index = 0; index < 8; index += 1) put(site, `many/f${index}.txt`, `file ${index}\n`);
    running = await startFtpCli(dir, ["--mode", "plain"]);
    const before = readCalls(dir).length;
    const { fs, login } = transport({ concurrency: 3 });
    const contents = await Promise.all(Array.from({ length: 8 }, (_, index) => fs.read(`many/f${index}.txt`)));
    expect(contents.map(String)).toEqual(Array.from({ length: 8 }, (_, index) => `file ${index}\n`));
    const loggedIn = readCalls(dir).slice(before).filter((entry) => entry.event === "login" && entry.ok);
    expect(loggedIn.length).toBeGreaterThan(1);
    expect(loggedIn.length).toBeLessThanOrEqual(3);
    expect(login.count.asked).toBe(1);
  }, 60_000);

  describe.skipIf(!hasOpenssl)("over TLS", () => {
    const fingerprint = (cert: string) => new X509Certificate(readFileSync(cert)).fingerprint256;

    it("asks to trust the self-signed certificate before the password goes out, then works encrypted", async () => {
      running = await startFtpCli(dir, ["--mode", "explicit", "--require-tls"]);
      const declined = transport({ secure: true }, { trust: () => false });
      const before = commands().length;
      await expect(declined.fs.connect()).rejects.toThrow("not trusted");
      expect(declined.login.count.asked).toBe(0);
      expect(commands().slice(before).map((entry) => entry.directive)).not.toContain("USER");

      const { fs, asked } = transport({ secure: true });
      await fs.connect();
      expect(fs.encrypted).toBe(true);
      expect(asked.certificates).toHaveLength(1);
      expect(asked.certificates[0]).toMatchObject({ address: "127.0.0.1:" + running.port, sha256: fingerprint(running.cert!), subject: "127.0.0.1" });
      put(site, "tls.txt", "over tls\n");
      expect((await fs.read("tls.txt")).toString()).toBe("over tls\n");
      await writeServerFile(fs, "tls.txt", Buffer.from("changed over tls\n"), { mode: 0o644, existing: true, dirMode: 0o755 });
      expect(readFileSync(join(site, "tls.txt"), "utf8")).toBe("changed over tls\n");
      const session = commands().slice(before + 1);
      const afterAuth = session.slice(session.findIndex((entry) => entry.directive === "PBSZ" || entry.directive === "USER"));
      expect(afterAuth.some((entry) => entry.directive === "STOR" && entry.tls === true)).toBe(true);
      expect(afterAuth.filter((entry) => ["USER", "PASS", "STOR", "RETR", "LIST"].includes(String(entry.directive))).every((entry) => entry.tls === true)).toBe(true);
    }, 60_000);

    it("runs secure: \"control\" as full TLS and speaks implicit FTPS", async () => {
      running = await startFtpCli(dir, ["--mode", "explicit", "--require-tls"]);
      const control = transport({ secure: "control" });
      await control.fs.connect();
      expect(control.fs.encrypted).toBe(true);
      await control.fs.close();
      await stopFtpCli(running);
      running = await startFtpCli(dir, ["--mode", "implicit"]);
      const implicit = transport({ secure: "implicit" });
      expect((await implicit.fs.list("")).some((entry) => entry.name === "index.php")).toBe(true);
      expect(implicit.asked.certificates).toHaveLength(1);
    }, 60_000);

    it("trusts a certificate named in secureOptions.ca without asking", async () => {
      running = await startFtpCli(dir, ["--mode", "explicit"]);
      const { fs, asked } = transport({ secure: true, secureOptions: { ca: [readFileSync(running.cert!, "utf8")] } });
      expect((await fs.list("")).length).toBeGreaterThan(0);
      expect(asked.certificates).toEqual([]);
    }, 30_000);
  });
});
