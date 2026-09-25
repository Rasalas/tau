import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  parseJsonc, readProfileChoices, readSftpJson, readSftpJsonFile, renderSftpJson, sftpJsonSecrets, sftpJsonTargetId,
  writeProfileChoice, writeSftpJson, type SftpJsonIssueCode, type SftpJsonTarget,
} from "./sftp-json.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", "sftp-json", `${name}.json`), "utf8");
const codes = (target: SftpJsonTarget): SftpJsonIssueCode[] => target.issues.map((issue) => issue.code).sort();

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tau-sftp-json-"));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("parseJsonc", () => {
  it("drops comments and trailing commas but leaves strings alone", () => {
    expect(parseJsonc(`\uFEFF{ // c\n "a": "x // y, }", /* b */ "b": [1, 2,], }`)).toEqual({ a: "x // y, }", b: [1, 2] });
    expect(parseJsonc(`{"q": "say \\"hi\\" /* no */"}`)).toEqual({ q: "say \"hi\" /* no */" });
  });
});

describe("readSftpJson fixtures", () => {
  it("liximomo: one object, defaults, plain password warned but never kept", async () => {
    const text = await fixture("liximomo");
    const { targets, issues } = readSftpJson(text);
    expect(issues).toEqual([]);
    expect(targets).toHaveLength(1);
    const [target] = targets as [SftpJsonTarget];
    expect(target).toMatchObject({
      name: "My Server", configKey: "My Server", context: "", protocol: "sftp", host: "example.com", port: 22,
      username: "deploy", remotePath: "/var/www/site", password: { value: "plain" }, hostVerification: true,
      ignore: [".vscode", ".git", ".DS_Store"], concurrency: 4, connectTimeout: 10_000, uploadOnSave: true, usable: true,
    });
    expect(codes(target)).toEqual(["plaintext-password", "upload-on-save-ignored"]);
    expect(JSON.stringify(target)).not.toContain("hunter2");
    expect(sftpJsonSecrets(text, target)).toEqual({ password: "hunter2" });
  });

  it("Natizyskunk: JSONC, key with passphrase prompt, temp-file upload, watcher, permissions", async () => {
    const { targets } = readSftpJson(await fixture("natizyskunk"));
    const [target] = targets as [SftpJsonTarget];
    expect(target).toMatchObject({
      host: "shop.example.com", port: 2222, privateKeyPath: "~/.ssh/id_ed25519", passphrase: { value: "ask" },
      password: { value: "ask" }, useTempFile: true, openSsh: true, watcher: true, uploadOnSave: false,
      syncDelete: true, filePerm: 0o644, dirPerm: 0o755, concurrency: 2,
    });
    expect(codes(target)).toEqual(["watcher-ignored"]);
  });

  it("danielratzinger fork: managers, commands, hop, host verification off, password null", async () => {
    const text = await fixture("fork-password-manager");
    const [target] = readSftpJson(text).targets as [SftpJsonTarget];
    expect(target.password).toEqual({ value: "ask", manager: { kind: "1password", ref: "op://Private/Agency/password" } });
    expect(target.passphrase).toEqual({ value: "ask", manager: { kind: "keychain" }, command: "pass show agency/key" });
    expect(target).toMatchObject({
      agent: "$SSH_AUTH_SOCK", sshConfigPath: "/Users/me/.ssh/config", knownHostsPath: "/Users/me/.ssh/known_hosts",
      hostVerification: false, interactiveAuth: "prompt", connectTimeout: 20_000,
      hop: [{ host: "bastion.example.com", port: 22, username: "jump" }],
    });
    expect(codes(target)).toEqual(["host-verification-off"]);
    expect(sftpJsonSecrets(text, target)).toEqual({});
  });

  it("profiles: defaultProfile merges over the root, ignore is appended, the choice wins", async () => {
    const text = await fixture("profiles");
    const dev = readSftpJson(text).targets[0]!;
    expect(dev).toMatchObject({ profiles: ["dev", "prod"], profile: "dev", host: "dev.blog.example.com", remotePath: "/var/www/blog-dev", ignore: [".git", "node_modules"] });
    const prod = readSftpJson(text, { profileChoices: { Blog: "prod" } }).targets[0]!;
    expect(prod).toMatchObject({ profile: "prod", host: "blog.example.com", remotePath: "/var/www/blog", ignore: [".git", "node_modules", "uploads"] });
    expect(codes(prod)).toContain("production-profile");
    expect(prod.id).not.toBe(dev.id);
    expect(prod.configKey).toBe(dev.configKey);
  });

  it("profiles: a stale choice falls back to defaultProfile; none at all asks for one", async () => {
    const text = await fixture("profiles");
    const stale = readSftpJson(text, { profileChoices: { Blog: "gone" } }).targets[0]!;
    expect(stale.profile).toBe("dev");
    expect(codes(stale)).toContain("unknown-profile");
    const withoutDefault = JSON.parse(text) as Record<string, unknown>;
    delete withoutDefault.defaultProfile;
    const bare = readSftpJson(JSON.stringify(withoutDefault)).targets[0]!;
    expect(bare.profile).toBeUndefined();
    expect(bare.usable).toBe(false);
    expect(codes(bare)).toContain("profile-required");
  });

  it("array with context: one target per config, FTP defaults and warnings", async () => {
    const root = "/work/site";
    const { targets, issues } = readSftpJson(await fixture("array-context"), { workspaceRoot: root });
    expect(issues).toEqual([]);
    const [theme, legacy] = targets as [SftpJsonTarget, SftpJsonTarget];
    expect(theme).toMatchObject({ index: 0, configKey: "theme", context: "wp-content/themes/site", protocol: "sftp", port: 22 });
    expect(legacy).toMatchObject({
      index: 1, configKey: "legacy", context: "legacy", protocol: "ftp", port: 21, secure: "control", concurrency: 1,
      remoteTimeOffsetInHours: -2, password: { value: "ask", manager: { kind: "none" } },
    });
    expect(codes(legacy)).toEqual(["ftp-secure-control"]);
  });

  it("two contexts, two profiles: the shape of the instance check", async () => {
    const { targets } = readSftpJson(await fixture("contexts-profiles"));
    expect(targets.map((target) => [target.configKey, target.context, target.profile, target.remotePath])).toEqual([
      ["app", "app", "staging", "/srv/app-staging"],
      ["static", "public", undefined, "/srv/static"],
    ]);
    expect(targets[0]!.profiles).toEqual(["staging", "production"]);
  });
});

describe("readSftpJson edge cases", () => {
  it("reports invalid JSON and non-objects", () => {
    expect(readSftpJson("{ nope").issues[0]!.code).toBe("invalid-json");
    expect(readSftpJson("[]").issues[0]!.code).toBe("not-a-config");
    const mixed = readSftpJson(`[1, {"host": "a", "username": "u", "remotePath": "/"}]`);
    expect(mixed.issues.map((issue) => issue.code)).toContain("not-a-config");
    expect(mixed.targets[0]!.index).toBe(1);
  });

  it("flags missing names, duplicate folders and folders outside the workspace", () => {
    const { targets, issues } = readSftpJson(JSON.stringify([
      { host: "a", username: "u", remotePath: "/a" },
      { host: "b", username: "u", remotePath: "/b", context: "./" },
      { name: "x", host: "c", username: "u", remotePath: "/c", context: "../up" },
    ]));
    expect(issues.map((issue) => issue.code)).toEqual(["missing-name", "duplicate-context"]);
    expect(targets.map((target) => target.configKey)).toEqual([".", ".#1", "x"]);
    expect(codes(targets[2]!)).toContain("context-outside");
    expect(targets[2]!.usable).toBe(false);
  });

  it("accepts an absolute context inside the workspace and rejects one outside", () => {
    const [inside, outside] = readSftpJson(JSON.stringify([
      { name: "a", host: "h", username: "u", remotePath: "/", context: "/work/site/sub" },
      { name: "b", host: "h", username: "u", remotePath: "/", context: "C:\\other" },
    ]), { workspaceRoot: "/work/site" }).targets as [SftpJsonTarget, SftpJsonTarget];
    expect(inside.context).toBe("sub");
    expect(codes(outside)).toContain("context-outside");
  });

  it("treats password null like left out, and ignores fields of the wrong type", () => {
    const [target] = readSftpJson(JSON.stringify({ host: "h", username: "u", password: null, port: "2200", concurrency: "many", remotePath: "/" })).targets as [SftpJsonTarget];
    expect(target.password).toEqual({ value: "ask" });
    expect(target.port).toBe(2200);
    expect(target.concurrency).toBe(4);
    expect(codes(target)).toEqual(["invalid-field"]);
  });

  it("defaults a missing remotePath to the login folder with a note, and rejects protocol local", () => {
    const [target] = readSftpJson(JSON.stringify({ host: "h", username: "u", protocol: "local" })).targets as [SftpJsonTarget];
    expect(target.remotePath).toBe("./");
    expect(codes(target)).toEqual(expect.arrayContaining(["remote-path-default", "unsupported-protocol"]));
    expect(target.usable).toBe(false);
  });

  it("warns about plain FTP, a VS Code remote reference and a missing FTP user", () => {
    const [target] = readSftpJson(JSON.stringify({ protocol: "ftp", host: "h", remote: "shared", remotePath: "/" })).targets as [SftpJsonTarget];
    expect(codes(target)).toEqual(expect.arrayContaining(["ftp-unencrypted", "remote-setting", "missing-username"]));
  });

  it("keeps preset interactive answers out of the target", () => {
    const text = JSON.stringify({ host: "h", username: "u", remotePath: "/", interactiveAuth: ["123456"] });
    const [target] = readSftpJson(text).targets as [SftpJsonTarget];
    expect(target.interactiveAuth).toBe("preset");
    expect(JSON.stringify(target)).not.toContain("123456");
    expect(sftpJsonSecrets(text, target).interactiveAnswers).toEqual(["123456"]);
  });

  it("reads secrets of the chosen profile", () => {
    const text = JSON.stringify({ name: "s", host: "h", username: "u", remotePath: "/", password: "root", profiles: { live: { password: "live" } } });
    expect(sftpJsonSecrets(text, { index: 0, profile: "live" })).toEqual({ password: "live" });
    expect(sftpJsonSecrets(text, { index: 0 })).toEqual({ password: "root" });
  });

  it("gives ids that are safe folder names and stable", () => {
    expect(sftpJsonTargetId("My Server")).toMatch(/^sftp-my-server-[0-9a-f]{8}$/u);
    expect(sftpJsonTargetId("../x", "prod")).toMatch(/^sftp-x--prod-[0-9a-f]{8}$/u);
    expect(sftpJsonTargetId("a")).toBe(sftpJsonTargetId("a"));
    expect(sftpJsonTargetId("a", "b")).not.toBe(sftpJsonTargetId("a-b"));
  });
});

describe("files", () => {
  it("reads .vscode/sftp.json of a workspace, and nothing when there is none", async () => {
    const root = await tempDir();
    expect(await readSftpJsonFile(root)).toBeUndefined();
    await mkdir(join(root, ".vscode"));
    await writeFile(join(root, ".vscode", "sftp.json"), await fixture("contexts-profiles"));
    const read = await readSftpJsonFile(root, { profileChoices: { app: "production" } });
    expect(read?.targets.map((target) => target.remotePath)).toEqual(["/srv/app", "/srv/static"]);
  });

  it("writes an sftp.json without a password and never over an existing one", async () => {
    const root = await tempDir();
    const path = await writeSftpJson(root, [{ protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv/site" }]);
    const text = await readFile(path, "utf8");
    expect(text).not.toMatch(/password|passphrase/u);
    expect(readSftpJson(text).targets[0]).toMatchObject({ host: "127.0.0.1", port: 2222, password: { value: "ask" }, usable: true });
    await expect(writeSftpJson(root, [{ protocol: "sftp", host: "x", remotePath: "/" }])).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(text);
    expect(() => renderSftpJson([])).not.toThrow();
    await expect(writeSftpJson(await tempDir(), [{ protocol: "ftp", host: "a", remotePath: "/" }, { protocol: "ftp", host: "b", remotePath: "/" }])).rejects.toThrow(/name/u);
  });

  it("keeps the profile choice in the given state file", async () => {
    const path = join(await tempDir(), "targets", "ws", "profiles.json");
    expect(await readProfileChoices(path)).toEqual({});
    await writeProfileChoice(path, "app", "production");
    await writeProfileChoice(path, "static", "x");
    expect(await readProfileChoices(path)).toEqual({ app: "production", static: "x" });
    await writeProfileChoice(path, "static", undefined);
    expect(await readProfileChoices(path)).toEqual({ app: "production" });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
});

describe("FTPS secureOptions", () => {
  const pem = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";
  const read = (config: Record<string, unknown>) => readSftpJson(JSON.stringify({ protocol: "ftp", host: "h", username: "u", ...config })).targets[0]!;

  it("passes on the TLS options Tau understands and says what it ignores", () => {
    const target = read({ secure: true, secureOptions: { ca: pem, servername: "ftp.example.com", minVersion: "TLSv1.2", rejectUnauthorized: false, pfx: "x" } });
    expect(target.secureOptions).toEqual({ ca: [pem], servername: "ftp.example.com", minVersion: "TLSv1.2", rejectUnauthorized: false });
    expect(target.issues.filter((issue) => issue.code === "ftp-secure-options").map((issue) => issue.message).join(" "))
      .toMatch(/still checks.*ignores these secureOptions: pfx/su);
  });

  it("reads no secureOptions for plain FTP or SFTP", () => {
    expect(read({ secureOptions: { ca: pem } }).secureOptions).toBeUndefined();
    expect(read({ protocol: "sftp", secure: true, secureOptions: { ca: pem } }).secureOptions).toBeUndefined();
    expect(codes(read({ secure: "control" }))).toContain("ftp-secure-control");
  });
});
