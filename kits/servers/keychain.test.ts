import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SecretToolStore, SecurityKeychain, parseKeychainAccounts, parseSecurityPassword, runProcess, securityWord, type ProcessRunner } from "./keychain.js";

const SECURITY = join(import.meta.dirname, "fixtures", "fake-security.mjs");
const SECRET_TOOL = join(import.meta.dirname, "fixtures", "fake-secret-tool.mjs");

// Recorded from /usr/bin/security (macOS 15) against throwaway items, values replaced.
const FOUND_STDOUT = `keychain: "/Users/someone/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    0x00000007 <blob>="deploy@example.com (site)"
    "acct"<blob>="sftp://deploy@example.com:22/site"
    "svce"<blob>="vscode-sftp"
`;
const ASCII_STDERR = "password: \"s3cret \"quoted\" pw\"\n";
const HEX_STDERR = "password: 0x70C3A4C39F776F7274  \"p\\303\\244\\303\\237wort\"\n";
const DUMP = `keychain: "/Users/someone/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="sftp://deploy@example.com:22/old"
    "cdat"<timedate>=0x32303234303130313030303030305A00  "20240101000000Z\\000"
    "mdat"<timedate>=0x32303234303130313030303030305A00  "20240101000000Z\\000"
    "svce"<blob>="vscode-sftp"
keychain: "/Users/someone/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="github.com"
    "mdat"<timedate>=0x32303236303130313030303030305A00  "20260101000000Z\\000"
    "svce"<blob>="other"
keychain: "/Users/someone/Library/Keychains/login.keychain-db"
version: 512
class: "genp"
attributes:
    "acct"<blob>="sftp://deploy@example.com:22/new"
    "cdat"<timedate>=0x32303234303130313030303030305A00  "20240101000000Z\\000"
    "mdat"<timedate>=0x32303235303630313030303030305A00  "20250601000000Z\\000"
    "svce"<blob>="vscode-sftp"
`;

describe("security output", () => {
  it("reads a printable password between the outermost quotes", () => {
    expect(parseSecurityPassword(`${ASCII_STDERR}${FOUND_STDOUT}`)).toBe("s3cret \"quoted\" pw");
  });

  it("reads the 0x form as UTF-8 hex", () => {
    expect(parseSecurityPassword(HEX_STDERR)).toBe("päßwort");
  });

  it("answers undefined without a password line", () => {
    expect(parseSecurityPassword(FOUND_STDOUT)).toBeUndefined();
    expect(parseSecurityPassword("password: 0xZZ\n")).toBeUndefined();
  });

  it("lists the accounts of one service from a dump, newest change first", () => {
    expect(parseKeychainAccounts(DUMP, "vscode-sftp")).toEqual(["sftp://deploy@example.com:22/new", "sftp://deploy@example.com:22/old"]);
    expect(parseKeychainAccounts(DUMP, "nothing")).toEqual([]);
  });

  it("quotes a word for security -i", () => {
    expect(securityWord("a \"b\" \\c")).toBe("\"a \\\"b\\\" \\\\c\"");
  });
});

describe("the stores against the I02 stubs", () => {
  let dir: string;
  let calls: { command: string; args: readonly string[]; input?: string }[];
  const recording: ProcessRunner = (command, args, options) => {
    calls.push({ command, args, ...(options?.input === undefined ? {} : { input: options.input }) });
    return runProcess(command, args, options);
  };
  const env = () => ({ PATH: process.env.PATH, HOME: dir, FAKE_SERVERS_STATE: dir });

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "tau-servers-keychain-"));
    calls = [];
  });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const secretIn = async (value: string) => {
    const hits: string[] = [];
    for (const name of await readdir(dir, { recursive: true })) {
      const text = await readFile(join(dir, name), "utf8").catch(() => "");
      if (text.includes(value)) hits.push(name);
    }
    return hits;
  };

  it("keeps a secret through security -i, reads it back and never puts it in argv or a file", async () => {
    const keychain = new SecurityKeychain(SECURITY, recording, env());
    const item = { service: "tau-servers", account: "sftp://tester@127.0.0.1:2222/site", label: "tester@127.0.0.1 (site)" };
    for (const value of ["plain", "with space \"quote\" and \\ backslash", "päßwort ✓"]) {
      await keychain.set(item, value);
      expect(await keychain.get(item)).toBe(value);
    }
    expect(await keychain.has(item)).toBe(true);
    expect(await keychain.accounts("tau-servers")).toEqual([item.account]);
    await keychain.delete(item);
    expect(await keychain.has(item)).toBe(false);
    expect(await keychain.get(item)).toBeUndefined();
    await expect(keychain.set(item, "two\nlines")).rejects.toThrow(/line break/u);
    expect(calls.every((call) => call.command === SECURITY)).toBe(true);
    expect(calls.flatMap((call) => call.args).join(" ")).not.toMatch(/päßwort|backslash|plain/u);
    expect(calls.filter((call) => call.input).every((call) => call.args.join(" ") === "-i")).toBe(true);
    expect(await secretIn("päßwort")).toEqual([]);
    expect(await secretIn("backslash")).toEqual([]);
  });

  it("keeps a secret in the Secret Service through stdin", async () => {
    const store = new SecretToolStore(SECRET_TOOL, recording, env());
    const item = { service: "tau-servers", account: "sftp://tester@127.0.0.1:2222/site", label: "tester@127.0.0.1 (site)" };
    expect(await store.get(item)).toBeUndefined();
    await store.set(item, "linux pw");
    expect(await store.get(item)).toBe("linux pw");
    expect(await store.has()).toBeUndefined();
    await store.delete(item);
    expect(await store.get(item)).toBeUndefined();
    expect(calls.flatMap((call) => call.args).join(" ")).not.toContain("linux pw");
    expect(await secretIn("linux pw")).toEqual([]);
  });
});
