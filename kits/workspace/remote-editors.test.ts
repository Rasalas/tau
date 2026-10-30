import { describe, expect, it } from "vitest";
import type { InstalledEditor } from "./editors.js";
import {
  chooseRemoteLocation,
  decodeRemoteLocation,
  formatSshDestination,
  parseSshDestination,
  remoteEditorCommand,
  remoteEditorUnsupported,
  remotePathInside,
  vscodeAuthority,
} from "./remote-editors.js";

const command = (id: string, name: string, path = id, baseArgs: string[] = []): InstalledEditor =>
  ({ id, name, launch: { kind: "command", command: path, style: id === "zed" ? "direct-path" : "goto", baseArgs } });
const app = (id: string, name: string, bundle: string): InstalledEditor => ({ id, name, launch: { kind: "app", bundle } });
const fromHex = (authority: string) => JSON.parse(Buffer.from(authority.replace(/^ssh-remote\+/u, ""), "hex").toString("utf8")) as unknown;

describe("parseSshDestination", () => {
  it.each([
    ["dev-box", { host: "dev-box" }, "dev-box"],
    ["my_alias", { host: "my_alias" }, "my_alias"],
    ["me@box.tail1234.ts.net", { user: "me", host: "box.tail1234.ts.net" }, "me@box.tail1234.ts.net"],
    ["box:2222", { host: "box", port: 2222 }, "box:2222"],
    ["  me@10.0.0.5:22 ", { user: "me", host: "10.0.0.5", port: 22 }, "me@10.0.0.5:22"],
    ["[::1]:2222", { host: "::1", port: 2222 }, "[::1]:2222"],
    ["me@[fe80::1%eth0]", { user: "me", host: "fe80::1%eth0" }, "me@[fe80::1%eth0]"],
    ["fd7a:115c:a1e0::1", { host: "fd7a:115c:a1e0::1" }, "[fd7a:115c:a1e0::1]"],
    ["ssh://me@box:2200/", { user: "me", host: "box", port: 2200 }, "me@box:2200"],
    ["me@corp.example@win-box", { user: "me@corp.example", host: "win-box" }, "me@corp.example@win-box"],
    ["CORP\\me@win-box", { user: "CORP\\me", host: "win-box" }, "CORP\\me@win-box"],
  ])("reads %s", (text, destination, formatted) => {
    const parsed = parseSshDestination(text);
    expect(parsed).toEqual({ destination });
    expect(formatSshDestination((parsed as { destination: Parameters<typeof formatSshDestination>[0] }).destination)).toBe(formatted);
  });

  it.each([
    ["", /user@host/u],
    ["me@ box", /No spaces/u],
    ["-oProxyCommand=evil", /not a host name/u],
    ["-me@box", /not a user name/u],
    ["box:0", /not a port/u],
    ["box:70000", /not a port/u],
    ["box:ssh", /not a port/u],
    ["ssh://box/home/me", /no path/u],
    ["[::1", /closing \]/u],
    ["[box]:22", /not an IPv6 address/u],
    ["me@", /user@host/u],
  ])("refuses %j", (text, message) => {
    const parsed = parseSshDestination(text);
    expect("error" in parsed && parsed.error).toMatch(message);
  });
});

describe("chooseRemoteLocation", () => {
  const name = "Studio";
  it("takes what the user entered over anything Tau knows", () => {
    expect(chooseRemoteLocation({ name, saved: "me@studio:2222", route: { kind: "ssh", target: "studio-tau" } }))
      .toEqual({ location: { kind: "ssh", destination: "me@studio:2222" }, source: "saved" });
    expect(chooseRemoteLocation({ name, saved: "bad host" }).problem).toMatch(/saved for Studio is not valid/u);
  });

  it("follows Tau's own SSH route, a WSL distribution, or the best name among the addresses", () => {
    expect(chooseRemoteLocation({ name, route: { kind: "ssh", target: "me@studio" } })).toEqual({ location: { kind: "ssh", destination: "me@studio" }, source: "tau-ssh" });
    expect(chooseRemoteLocation({ name, route: { kind: "wsl", distro: "Ubuntu-24.04" } })).toEqual({ location: { kind: "wsl", distro: "Ubuntu-24.04" }, source: "wsl" });
    expect(chooseRemoteLocation({ name, route: { kind: "direct", hosts: ["studio.tail1234.ts.net", "192.168.1.20", "127.0.0.1"] }, address: "https://192.168.1.20:7788/" }))
      .toEqual({ location: { kind: "ssh", destination: "studio.tail1234.ts.net" }, source: "address" });
    expect(chooseRemoteLocation({ name, address: "wss://[fd7a:115c::5]:7788/" })).toEqual({ location: { kind: "ssh", destination: "[fd7a:115c::5]" }, source: "address" });
  });

  it("never takes a machine known only at a loopback address for this computer", () => {
    // A manual `ssh -L 7788:localhost:7788 studio` looks just like another Tau here; its paths are studio's.
    for (const route of [{ kind: "direct" as const, hosts: ["127.0.0.1", "localhost"] }, { kind: "direct" as const, hosts: ["::1"] }]) {
      const choice = chooseRemoteLocation({ name, route });
      expect(choice.location).toBeUndefined();
      expect(choice.problem).toMatch(/only at a local address.*Enter its SSH destination/u);
    }
    expect(chooseRemoteLocation({ name, address: "https://127.0.0.1:41000/" }).problem).toMatch(/only at a local address/u);
    expect(chooseRemoteLocation({ name, saved: "studio", route: { kind: "direct", hosts: ["127.0.0.1"] } }).location).toEqual({ kind: "ssh", destination: "studio" });
  });

  it("explains that a machine reached only through Tau Connect needs an SSH destination", () => {
    expect(chooseRemoteLocation({ name, route: { kind: "connect" }, address: "https://relay.example/x" }).problem).toMatch(/Tau Connect, which carries no SSH/u);
    expect(chooseRemoteLocation({ name }).problem).toMatch(/does not know how this device reaches Studio/u);
  });
});

describe("vscodeAuthority", () => {
  it("writes an alias and user@host as Remote-SSH does, and hex JSON for what that form cannot carry", () => {
    expect(vscodeAuthority({ kind: "ssh", destination: "dev-box" })).toBe("ssh-remote+dev-box");
    expect(vscodeAuthority({ kind: "ssh", destination: "me@box.local" })).toBe("ssh-remote+me@box.local");
    expect(fromHex(vscodeAuthority({ kind: "ssh", destination: "me@box:2222" }))).toEqual({ hostName: "me@box -p 2222" });
    expect(fromHex(vscodeAuthority({ kind: "ssh", destination: "[fd7a::1]" }))).toEqual({ hostName: "fd7a::1" });
    expect(fromHex(vscodeAuthority({ kind: "ssh", destination: "me@corp@win-box" }))).toEqual({ hostName: "me@corp@win-box" });
    expect(vscodeAuthority({ kind: "wsl", distro: "Ubuntu" })).toBe("wsl+Ubuntu");
  });
});

describe("remoteEditorCommand", () => {
  const ssh = { kind: "ssh" as const, destination: "me@studio" };
  const root = "/home/me/My Project";

  it("opens the folder, and a file in the folder's window at a line, with VS Code's --remote", () => {
    const code = command("code", "VS Code");
    expect(remoteEditorCommand(code, { location: ssh, root })).toEqual({ command: "code", args: ["--remote", "ssh-remote+me@studio", root] });
    expect(remoteEditorCommand(code, { location: ssh, root, file: `${root}/src/a b.ts` }))
      .toEqual({ command: "code", args: ["--remote", "ssh-remote+me@studio", root, `${root}/src/a b.ts`] });
    expect(remoteEditorCommand(code, { location: ssh, root, file: `${root}/a.ts`, position: { line: 12, column: 3 } }))
      .toEqual({ command: "code", args: ["--remote", "ssh-remote+me@studio", "--goto", root, `${root}/a.ts:12:3`] });
    expect(remoteEditorCommand(command("cursor", "Cursor", "cursor", ["--classic"]), { location: { kind: "wsl", distro: "Ubuntu" }, root: "/home/me/p" }))
      .toEqual({ command: "cursor", args: ["--classic", "--remote", "wsl+Ubuntu", "/home/me/p"] });
  });

  it("keeps the remote path a POSIX path from a Windows client and writes a Windows machine's path as VS Code reads it", () => {
    const code = command("code", "VS Code", "C:\\Users\\me\\AppData\\Local\\Programs\\Microsoft VS Code\\bin\\code.cmd");
    expect(remoteEditorCommand(code, { location: ssh, root: "/srv/app" }).args).toEqual(["--remote", "ssh-remote+me@studio", "/srv/app"]);
    expect(remoteEditorCommand(code, { location: ssh, root: "C:\\Users\\me\\My Project", file: "C:\\Users\\me\\My Project\\a.ts", position: { line: 2 }, platform: "win32" }).args)
      .toEqual(["--remote", "ssh-remote+me@studio", "--goto", "/C:/Users/me/My Project", "/C:/Users/me/My Project/a.ts:2"]);
  });

  it("hands a macOS bundle without its launcher the editor's own remote URL", () => {
    expect(remoteEditorCommand(app("code", "VS Code", "/Applications/Visual Studio Code.app"), { location: ssh, root, file: `${root}/a#b.ts`, position: { line: 4 } }))
      .toEqual({ command: "open", args: ["vscode://vscode-remote/ssh-remote+me@studio/home/me/My%20Project/a%23b.ts:4"] });
    expect(remoteEditorCommand(app("cursor", "Cursor", "/Applications/Cursor.app"), { location: { kind: "ssh", destination: "studio:2222" }, root: "/p" }).args[0])
      .toMatch(/^cursor:\/\/vscode-remote\/ssh-remote\+[0-9a-f]+\/p$/u);
    expect(remoteEditorUnsupported(app("trae", "Trae", "/Applications/Trae.app"), ssh)).toMatch(/command-line launcher/u);
  });

  it("gives Zed ssh:// URLs with the user, the port and an IPv6 address in brackets", () => {
    const zed = command("zed", "Zed");
    expect(remoteEditorCommand(zed, { location: { kind: "ssh", destination: "me@[fd7a::1]:2222" }, root, file: `${root}/a.ts`, position: { line: 9 } }))
      .toEqual({ command: "zed", args: ["ssh://me@[fd7a::1]:2222/home/me/My%20Project", "ssh://me@[fd7a::1]:2222/home/me/My%20Project/a.ts"] });
    expect(remoteEditorCommand(zed, { location: { kind: "ssh", destination: "me@corp@box" }, root: "/p" }).args).toEqual(["ssh://me%40corp@box/p"]);
    expect(remoteEditorCommand(app("zed", "Zed", "/Applications/Zed.app"), { location: { kind: "ssh", destination: "studio" }, root: "/p" })).toEqual({ command: "open", args: ["zed://ssh/studio/p"] });
    expect(() => remoteEditorCommand(zed, { location: { kind: "wsl", distro: "Ubuntu" }, root: "/p" })).toThrow(/Open WSL/u);
  });

  it("says why an editor without remote support cannot open the project", () => {
    expect(remoteEditorUnsupported(command("idea", "IntelliJ IDEA"), ssh)).toMatch(/JetBrains Gateway/u);
    expect(remoteEditorUnsupported(command("subl", "Sublime Text"), ssh)).toMatch(/cannot open a folder on another machine/u);
    expect(remoteEditorUnsupported({ id: "file-manager", name: "Finder", launch: { kind: "file-manager" } }, ssh)).toMatch(/this device's files only/u);
    expect(() => remoteEditorCommand(command("subl", "Sublime Text"), { location: ssh, root: "/p" })).toThrow(/Sublime Text/u);
  });
});

describe("remote locations and paths from the wire", () => {
  it("normalizes a destination and refuses what is no location", () => {
    expect(decodeRemoteLocation({ kind: "ssh", destination: " ssh://me@box:22 " })).toEqual({ kind: "ssh", destination: "me@box:22" });
    expect(decodeRemoteLocation({ kind: "wsl", distro: "Ubuntu-24.04" })).toEqual({ kind: "wsl", distro: "Ubuntu-24.04" });
    expect(() => decodeRemoteLocation({ kind: "ssh", destination: "-oProxyCommand=x" })).toThrow();
    expect(() => decodeRemoteLocation({ kind: "wsl", distro: "-d evil" })).toThrow();
    expect(() => decodeRemoteLocation(undefined)).toThrow();
    expect(() => decodeRemoteLocation({ kind: "same-machine" })).toThrow();
  });

  it("takes only a path inside the project", () => {
    expect(remotePathInside("/home/me/p", "/home/me/p")).toBe(true);
    expect(remotePathInside("/home/me/p", "/home/me/p/src/a.ts")).toBe(true);
    expect(remotePathInside("/home/me/p", "/home/me/p2/a.ts")).toBe(false);
    expect(remotePathInside("/home/me/p", "/home/me/p/../q")).toBe(false);
    expect(remotePathInside("home/me/p", "home/me/p")).toBe(false);
    expect(remotePathInside("/home/me/p", "/home/me/p/a\nb")).toBe(false);
    expect(remotePathInside("C:\\Users\\Me\\p", "c:\\users\\me\\P\\a.ts", "win32")).toBe(true);
    expect(remotePathInside("C:\\Users\\Me\\p", "C:\\Users\\Me\\q", "win32")).toBe(false);
  });
});
