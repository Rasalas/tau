import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createServersHostExtension } from "./host.js";
import { SERVERS_EXTENSION_ID, decodeServerTargetsState } from "./protocol.js";
import { ServersStore } from "./store.js";
import { ServerTargets, describeCredential } from "./targets.js";

const temps: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "tau-server-targets-")));
  temps.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function project(fixture = "contexts-profiles"): Promise<string> {
  const root = await tempDir();
  await mkdir(join(root, ".vscode"));
  await copyFile(join(import.meta.dirname, "fixtures", "sftp-json", `${fixture}.json`), join(root, ".vscode", "sftp.json"));
  return root;
}

function services(root: string, extra: Partial<HostExtensionServices> = {}): HostExtensionServices {
  return {
    knownWorkspacePath: async (path: string) => {
      if (path !== root) throw new Error("not admitted");
      return path;
    },
    workspaceRef: () => ({ workspaceId: "ws-1" }),
    findCommand: () => undefined,
    ...extra,
  } as unknown as HostExtensionServices;
}

const noGit = async () => "";

describe("ServerTargets", () => {
  it("lists the targets of a project and keeps the profile choice outside it", async () => {
    const root = await project();
    const state = await tempDir();
    const targets = new ServerTargets({ services: services(root), store: new ServersStore(state, console), git: noGit, env: {} });
    const first = await targets.state(root);
    expect(first.file).toBe(join(root, ".vscode", "sftp.json"));
    expect(first.targets.map((target) => [target.label, target.context, target.profile, target.remotePath])).toEqual([
      ["app", "app", "staging", "/srv/app-staging"],
      ["static", "public", undefined, "/srv/static"],
    ]);
    const after = await targets.setProfile({ cwd: root, configKey: "app", profile: "production" });
    expect(after.targets[0]).toMatchObject({ profile: "production", remotePath: "/srv/app" });
    expect(after.targets[0]!.issues.map((issue) => issue.code)).toContain("production-profile");
    expect(JSON.parse(await readFile(join(state, "targets", "ws-1", "profiles.json"), "utf8"))).toMatchObject({ choices: { app: "production" } });
    const reset = await targets.setProfile({ cwd: root, configKey: "app", profile: null });
    expect(reset.targets[0]!.profile).toBe("staging");
    await expect(targets.setProfile({ cwd: root, configKey: "app", profile: "nope" })).rejects.toThrow(/no profile/u);
    await expect(targets.state("/elsewhere")).rejects.toThrow();
  });

  it("answers an empty state for a project without sftp.json and writes one only when asked", async () => {
    const root = await tempDir();
    const targets = new ServerTargets({ services: services(root), store: new ServersStore(await tempDir(), console), git: noGit, env: {} });
    expect(await targets.state(root)).toEqual({ workspace: root, targets: [], issues: [] });
    const written = await targets.writeSftpJson({ cwd: root, drafts: [{ protocol: "sftp", host: "127.0.0.1", port: 2222, username: "tester", remotePath: "/srv", password: "leak" }] });
    expect(written.targets).toHaveLength(1);
    expect(await readFile(join(root, ".vscode", "sftp.json"), "utf8")).not.toContain("leak");
    await expect(targets.writeSftpJson({ cwd: root, drafts: [{ host: "x", remotePath: "/" }] })).rejects.toThrow(/already has an sftp.json/u);
  });

  it("reads only the ssh config a test instance names, never the user's with the loopback guard", async () => {
    const root = await tempDir();
    const home = await tempDir();
    const config = join(home, "ssh_config");
    await writeFile(config, "Host fake\n  HostName 127.0.0.1\n");
    const store = new ServersStore(await tempDir(), console);
    const guarded = new ServerTargets({ services: services(root), store, env: { TAU_SERVERS_LOOPBACK_ONLY: "1" }, home });
    await expect(guarded.sshHosts()).rejects.toThrow(/never reads the real ssh config/u);
    const named = new ServerTargets({ services: services(root), store, env: { TAU_SERVERS_LOOPBACK_ONLY: "1", TAU_SERVERS_SSH_CONFIG: config }, home });
    expect(await named.sshHosts()).toEqual({ configPath: config, hosts: ["fake"], problems: [] });
    await expect(named.resolveSshHost({ alias: "fake" })).rejects.toThrow(/not on this machine's PATH/u);
  });

  it("describes where a secret comes from without its value", () => {
    expect(describeCredential({ value: "plain" })).toBe("Plain text in sftp.json");
    expect(describeCredential({ value: "ask" })).toBe("Asked once, then kept in the keychain");
    expect(describeCredential({ value: "ask", manager: { kind: "none" } })).toBe("Asked every time");
    expect(describeCredential({ value: "ask", manager: { kind: "1password", ref: "op://V/I/password" } })).toBe("1Password (op://V/I/password)");
    expect(describeCredential({ value: "plain", command: "pass show x" })).toBe("Command in sftp.json");
  });
});

describe("Servers host half: target commands", () => {
  it("answers targets through the registry", async () => {
    const root = await project();
    const state = await tempDir();
    const registry = await activateHostKit(createServersHostExtension(), { ...services(root), stateDir: state });
    try {
      const answer = decodeServerTargetsState(await registry.invoke(SERVERS_EXTENSION_ID, "targets", { cwd: root }));
      expect(answer?.targets.map((target) => target.configKey)).toEqual(["app", "static"]);
    } finally {
      await registry.dispose();
    }
  });
});
