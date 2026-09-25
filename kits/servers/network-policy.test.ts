import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NETWORK_LIMIT_REASON, PACKAGE_SOURCE_HOSTS, ServerNetwork } from "./network-policy.js";
import { ServersStore } from "./store.js";

let root: string;
let project: string;
let store: ServersStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-servers-network-"));
  project = join(root, "project");
  await mkdir(project, { recursive: true });
  store = new ServersStore(join(root, "state"), { warn: () => undefined });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function network(options: { changed?: (cwd: string) => void; workspaceId?: string } = {}) {
  return new ServerNetwork({
    services: { workspaceRef: () => ({ workspaceId: options.workspaceId ?? "ws-1" }) as never },
    store,
    logger: { warn: () => undefined },
    // No Git: the folder is its own main checkout.
    git: async () => "",
    ...(options.changed ? { changed: options.changed } : {}),
    piEnforcement: async () => ({ available: true }),
  });
}

async function addSftpJson(): Promise<void> {
  await mkdir(join(project, ".vscode"), { recursive: true });
  await writeFile(join(project, ".vscode", "sftp.json"), JSON.stringify({ host: "127.0.0.1", remotePath: "/srv" }));
}

describe("ServerNetwork", () => {
  it("leaves a project without servers alone", async () => {
    expect(await network().rule(project)).toBeUndefined();
    expect(await network().state(project)).toMatchObject({ serverProject: false, allowAll: false, allowHosts: [] });
  });

  it("limits a project with an sftp.json to loopback and the package sources", async () => {
    await addSftpJson();
    expect(await network().rule(project)).toEqual({ network: "loopback", allowHosts: [...PACKAGE_SOURCE_HOSTS], reason: NETWORK_LIMIT_REASON });
    expect(PACKAGE_SOURCE_HOSTS).toEqual(expect.arrayContaining(["registry.npmjs.org", "repo.packagist.org", "github.com", "pypi.org"]));
  });

  it("limits a project that has a target folder but no sftp.json", async () => {
    await mkdir(join(store.targetsDir, "ws-1", "target-a"), { recursive: true });
    expect((await network().rule(project))?.network).toBe("loopback");
  });

  it("adds the hosts the user allowed, keeps them on this machine, and lifts the limit on request", async () => {
    await addSftpJson();
    const changed = vi.fn();
    const subject = network({ changed });
    const state = await subject.set({ cwd: project, allowHosts: ["API.Example.com", "*.cdn.example.net", "api.example.com"] });
    expect(state).toMatchObject({ serverProject: true, allowAll: false, allowHosts: ["*.cdn.example.net", "api.example.com"], pi: { available: true } });
    expect((await subject.rule(project))?.allowHosts).toEqual([...PACKAGE_SOURCE_HOSTS, "*.cdn.example.net", "api.example.com"]);
    const file = join(store.targetsDir, "ws-1", "network.json");
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ allowAll: false, allowHosts: ["*.cdn.example.net", "api.example.com"] });
    expect((await stat(file)).mode & 0o077).toBe(0);
    await subject.set({ cwd: project, allowAll: true });
    expect(await subject.rule(project)).toEqual({ network: "any" });
    expect((await subject.state(project)).allowHosts).toEqual(["*.cdn.example.net", "api.example.com"]);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledWith(project);
  });

  it("refuses what is not a host name instead of dropping it", async () => {
    await addSftpJson();
    await expect(network().set({ cwd: project, allowHosts: ["https://example.com"] })).rejects.toThrow(/not a host name/u);
    await expect(network().set({ cwd: project, allowAll: "yes" })).rejects.toThrow(/true or false/u);
    await expect(network().set({ allowAll: true })).rejects.toThrow(/Open a project/u);
  });

  it("keeps a limit when the settings file cannot be read", async () => {
    await addSftpJson();
    await mkdir(join(store.targetsDir, "ws-1"), { recursive: true });
    await writeFile(join(store.targetsDir, "ws-1", "network.json"), "{ not json");
    expect((await network().rule(project))?.network).toBe("loopback");
  });
});
