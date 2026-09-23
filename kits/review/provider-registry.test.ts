import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtensionContext } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { createReviewHostExtension } from "./host.js";
import { REVIEW_HOST_EXTENSION_ID, type ReviewRequestStatus, type SourceProviderStatus } from "./protocol.js";
import type { HttpFetch } from "./provider.js";
import { normalizeHost } from "./provider-registry.js";
import { knownService, serviceFor, type CliRunOptions } from "./request-cli.js";
import { LINK_SEAMS } from "./test-seams.js";

const fixture = (name: string) => readFile(join(import.meta.dirname, "fixtures", name), "utf8");
const none = () => undefined;

const stateRoots: string[] = [];
afterEach(async () => { await Promise.all(stateRoots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

describe("which provider a remote belongs to", () => {
  it("reads the host's name, not words elsewhere in the URL", () => {
    expect(serviceFor("git@github.com:acme/gitlab-tools.git", none)).toBe("github");
    expect(serviceFor("https://gitlab.example.com/acme/tau.git", none)).toBe("gitlab");
    expect(serviceFor("https://github.acme.corp/acme/tau.git", none)).toBe("github");
    expect(serviceFor("https://codeberg.org/forgejo/forgejo.git", none)).toBe("forgejo");
    expect(serviceFor("ssh://git@gitea.example.org:2222/acme/tau.git", none)).toBe("forgejo");
    expect(serviceFor("git@bitbucket.org:acme/tau.git", none)).toBe("bitbucket");
    expect(serviceFor("git@ssh.dev.azure.com:v3/acme/tau/tau", none)).toBe("azure-devops");
    expect(serviceFor("https://acme.visualstudio.com/tau/_git/tau", none)).toBe("azure-devops");
    expect(knownService("git.example.com")).toBeUndefined();
  });

  it("lets the user's choice for a self-hosted server win, with or without its port", () => {
    expect(serviceFor("https://git.example.com/acme/tau.git", none)).toBe("github");
    expect(serviceFor("/tmp/remote.git", (name) => (name === "glab" ? "/bin/glab" : undefined))).toBe("gitlab");
    const hosts = { "git.example.com": "forgejo" as const, "code.example.com:8443": "gitlab" as const };
    expect(serviceFor("git@git.example.com:acme/tau.git", none, hosts)).toBe("forgejo");
    expect(serviceFor("https://git.example.com:3000/acme/tau.git", none, hosts)).toBe("forgejo");
    expect(serviceFor("https://code.example.com:8443/acme/tau.git", none, hosts)).toBe("gitlab");
    expect(normalizeHost(" https://Git.Example.com:3000/acme ")).toBe("git.example.com:3000");
    expect(normalizeHost("not a host")).toBeUndefined();
    expect(normalizeHost("localhost")).toBeUndefined();
  });
});

async function harness(options: { remote?: string; tools?: Record<string, string>; answer?(args: string[], options?: CliRunOptions): string | Promise<string> } = {}) {
  const stateRoot = await mkdtemp(join(tmpdir(), "tau-sources-"));
  stateRoots.push(stateRoot);
  const calls: string[][] = [];
  const workspace = {
    id: "tau.workspace",
    name: "Workspace Kit",
    permissions: [] as string[],
    activate(context: HostExtensionContext) {
      context.registerCommand("review-request-context", () => ({
        root: "/project", branch: "feature/x", base: "main", remote: { name: "origin", url: options.remote ?? "https://git.example.com:3000/acme/tau.git" },
      }), { callers: [REVIEW_HOST_EXTENSION_ID] });
      context.registerCommand("review-request", () => undefined, { callers: [REVIEW_HOST_EXTENSION_ID] });
    },
  };
  const run = vi.fn(async (_command: string, args: string[], _cwd: string, runOptions?: CliRunOptions) => {
    calls.push(args);
    if (options.answer) return options.answer(args, runOptions);
    if (args[0] === "login") return fixture("tea-logins.json");
    runOptions?.onStderr?.("HTTP/2.0 200 OK\n");
    return "[]";
  });
  const fetch: HttpFetch = vi.fn(async () => ({ status: 200, headers: { get: () => null }, text: async () => "{}" }));
  const tools = options.tools ?? { gh: "/bin/gh", tea: "/bin/tea" };
  const registry = await activateHostKit(workspace, { ...LINK_SEAMS, findCommand: (name: string) => tools[name], noteSubprocess: () => undefined, stateDir: stateRoot, runtimeOwner: () => "tau" });
  await registry.activate(createReviewHostExtension({ run, fetch, env: {} }));
  const invoke = <T = unknown>(command: string, input?: unknown) => registry.invoke(REVIEW_HOST_EXTENSION_ID, command, input) as Promise<T>;
  return { invoke, calls, stateRoot };
}

describe("self-hosted servers", () => {
  it("keeps the user's choice per host in the kit's own state and reads the remote with it", async () => {
    const { invoke, calls, stateRoot } = await harness();
    expect((await invoke<ReviewRequestStatus>("pr-status")).service).toBe("github");
    await expect(invoke("set-source-host", { host: "https://git.example.com:3000", service: "forgejo" })).resolves.toEqual({ "git.example.com:3000": "forgejo" });
    const stored = JSON.parse(await readFile(join(stateRoot, REVIEW_HOST_EXTENSION_ID, "source-hosts.json"), "utf8")) as { version: number; hosts: Record<string, string> };
    expect(stored).toEqual({ version: 1, hosts: { "git.example.com:3000": "forgejo" } });
    const status = await invoke<ReviewRequestStatus>("pr-status");
    expect(status.service).toBe("forgejo");
    expect(status.problem).toBeUndefined();
    // tea's login for that server signs the call.
    expect(calls.find((args) => args[0] === "api")).toEqual(["api", "--include", "--login", "work", "--method", "GET", "https://git.example.com:3000/api/v1/repos/acme/tau/pulls?state=all&sort=recentupdate&limit=50"]);
    await expect(invoke("set-source-host", { host: "git.example.com:3000", service: null })).resolves.toEqual({});
    await expect(invoke("set-source-host", { host: "nope", service: "forgejo" })).rejects.toThrow(/Name the server by its host/u);
    await expect(invoke("set-source-host", { host: "git.example.com", service: "svn" })).rejects.toThrow(/Choose GitHub/u);
  });

  it("says per provider whether this machine can reach it", async () => {
    const { invoke } = await harness({
      tools: { gh: "/bin/gh", tea: "/bin/tea", git: "/usr/bin/git", az: "/bin/az" },
      answer: async (args, runOptions) => {
        if (args.join(" ") === "auth status") { runOptions?.onStderr?.("github.com\n  ✓ Logged in to github.com account octo (keyring)\n"); return ""; }
        if (args[0] === "login") return fixture("tea-logins.json");
        if (args.includes("credential")) return "protocol=https\nhost=api.bitbucket.org\nusername=octo@example.com\npassword=secret\n";
        if (args[0] === "extension") throw new Error("ERROR: The extension azure-devops is not installed.");
        return "";
      },
    });
    const statuses = await invoke<SourceProviderStatus[]>("source-providers");
    expect(statuses.map((entry) => [entry.service, entry.installed, entry.signedIn, entry.account])).toEqual([
      ["github", true, true, "octo"],
      ["gitlab", false, undefined, undefined],
      ["forgejo", true, true, "octo on codeberg.org, octo on git.example.com:3000"],
      ["bitbucket", true, true, "octo@example.com"],
      ["azure-devops", true, undefined, undefined],
    ]);
    expect(statuses.find((entry) => entry.service === "gitlab")!.hint).toMatch(/GitLab CLI \(glab\) is not installed/u);
    expect(statuses.find((entry) => entry.service === "azure-devops")!.hint).toMatch(/az extension add --name azure-devops/u);
    expect(JSON.stringify(statuses)).not.toContain("secret");
  });
});
