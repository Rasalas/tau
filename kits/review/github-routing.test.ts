import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostExtension, HostExtensionContext, HostMachine, HostPairedDevice } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import type { HostExtensionRegistry } from "../../src/main/host-extensions.js";
import { createGitHubRouting } from "./github-routing.js";
import type { ProviderTools, SourceControlProvider } from "./provider.js";
import { REVIEW_HOST_EXTENSION_ID as ID } from "./protocol.js";

const roots: string[] = [];
const registries: HostExtensionRegistry[] = [];
afterEach(async () => { await Promise.all(registries.splice(0).map((registry) => registry.dispose())); await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const ref = { service: "github", host: "github.com", repo: "acme/tau", number: 7, url: "https://github.com/acme/tau/pull/7" };
const principal = (id: string, readOnly = false) => ({ kind: "workbench-client" as const, pairedClient: id, ...(readOnly ? { readOnly: true as const } : {}) });

async function pair() {
  const stateA = await mkdtemp(join(tmpdir(), "tau-gh-a-"));
  const stateB = await mkdtemp(join(tmpdir(), "tau-gh-b-"));
  roots.push(stateA, stateB);
  let accountA = 42;
  let accountB = 42;
  const machinesA: HostMachine[] = [{ id: "b", name: "B", status: "connected", address: "https://b", trustIdentity: "key-b" }];
  const machinesB: HostMachine[] = [{ id: "a", name: "A", status: "connected", address: "https://a", trustIdentity: "key-a" }];
  const devicesA: HostPairedDevice[] = [{ id: "b-device", name: "B Agents", access: "full" }];
  const devicesB: HostPairedDevice[] = [{ id: "a-device", name: "A Agents", access: "full" }];
  const localDetail = vi.fn(async () => { throw new Error("Local read unavailable"); });
  const remoteDetail = vi.fn(async () => ({ title: "Remote PR" }));
  const localWrite = vi.fn(async () => undefined);
  const remoteWrite = vi.fn(async () => undefined);
  const callsA = vi.fn(async (_machine: string, _extension: string, command: string, input: unknown) => registryB.invoke(ID, command, input, principal("a-device", machinesA[0]?.readOnly)));
  const callsB = vi.fn(async (_machine: string, _extension: string, command: string, input: unknown) => registryA.invoke(ID, command, input, principal("b-device", machinesB[0]?.readOnly)));
  const make = async (stateDir: string, ownId: string, machines: HostMachine[], devices: HostPairedDevice[], call: typeof callsA, account: () => number, detail: typeof localDetail | typeof remoteDetail, comment: typeof localWrite) => {
    const extension: HostExtension = { id: ID, name: "Review routing", permissions: ["machines"], activate(context: HostExtensionContext) {
      const local = { kind: "github", detail, comment, merge: comment, autoMerge: comment, revert: comment, stackAction: comment, stack: detail, changes: vi.fn(async () => []), create: vi.fn(async () => "created") } as unknown as SourceControlProvider;
      const tools = { cli: vi.fn(async () => JSON.stringify({ id: account() })) } as unknown as ProviderTools;
      const routing = createGitHubRouting(context, local, tools);
      context.registerCommand("test-detail", () => routing.provider.detail(ref as never, true), { access: "read" });
      context.registerCommand("test-comment", () => routing.provider.comment(ref as never, "hello"));
      context.registerCommand("test-merge", () => routing.provider.merge({ host: ref.host, repo: ref.repo }, { number: ref.number } as never, "squash"));
      context.registerCommand("test-auto-merge", () => routing.provider.autoMerge!({ host: ref.host, repo: ref.repo }, { number: ref.number } as never, true, "squash"));
      context.registerCommand("test-revert", () => routing.provider.revert!(ref as never, { nodeId: "PR_123" } as never));
      context.registerCommand("test-stack-action", () => routing.provider.stackAction!(ref as never, { action: "merge", seen: { number: 1, base: "main", layers: [{ number: 7, url: ref.url, headRef: "feature", headSha: "abc", state: "open" }] }, method: "squash" }));
      context.registerCommand("test-changes", () => routing.provider.changes!(ref as never, true), { access: "read" });
      return routing.dispose;
    } };
    const registry = await activateHostKit(extension, {
      stateDir,
      machines: { self: { id: ownId, name: ownId, version: "1" }, list: () => machines, subscribe: () => () => undefined, call } as never,
      clients: { devices: () => devices, count: () => 0, observe: () => () => undefined },
    });
    registries.push(registry);
    return registry;
  };
  const registryA = await make(stateA, "a", machinesA, devicesA, callsA, () => accountA, localDetail, localWrite);
  const registryB = await make(stateB, "b", machinesB, devicesB, callsB, () => accountB, remoteDetail, remoteWrite);
  const grant = async (mode = "read", preferred = false) => {
    await registryA.invoke(ID, "github-sharing-set", { id: "b", direction: "machine", host: "github.com", mode, preferred });
    await registryB.invoke(ID, "github-sharing-set", { id: "a-device", machine: "a", direction: "device", host: "github.com", mode });
  };
  return { registryA, registryB, grant, localDetail, remoteDetail, localWrite, remoteWrite, callsA, callsB, machinesA, machinesB, devicesB,
    accountA: (next: number) => { accountA = next; }, accountB: (next: number) => { accountB = next; }, stateA, stateB };
}

describe("GitHub access across paired hosts", () => {
  it("requires both approvals and independently verifies the same account", async () => {
    const p = await pair();
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    await p.registryA.invoke(ID, "github-sharing-set", { id: "b", direction: "machine", host: "github.com", mode: "read" });
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    await p.grant();
    await expect(p.registryA.invoke(ID, "test-detail")).resolves.toEqual({ title: "Remote PR" });
    expect(p.callsB).toHaveBeenCalledWith("a", ID, "github-sharing-identity", { host: "github.com" });
    p.accountB(99);
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    await expect(p.grant()).rejects.toThrow("different GitHub accounts");
  });
  it("prefers local reads and keeps filesystem operations local", async () => {
    const p = await pair();
    await p.grant();
    p.localDetail.mockResolvedValueOnce({ title: "Local PR" } as never);
    p.callsA.mockClear();
    await expect(p.registryA.invoke(ID, "test-detail")).resolves.toEqual({ title: "Local PR" });
    await expect(p.registryA.invoke(ID, "test-changes")).resolves.toEqual([]);
    expect(p.callsA).not.toHaveBeenCalled();
  });
  it("refuses read-only writes at the origin and receiver", async () => {
    const p = await pair();
    await p.grant("act");
    await expect(p.registryA.invoke(ID, "test-comment", undefined, principal("observer", true))).rejects.toThrow();
    await expect(p.registryB.invoke(ID, "github-sharing-act", { source: "a", account: "42", host: "github.com", operation: "comment", args: [ref, "hello"] }, principal("a-device", true))).rejects.toThrow();
    p.devicesB[0] = { id: "a-device", name: "A", access: "read-only" };
    await expect(p.registryB.invoke(ID, "github-sharing-act", { source: "a", account: "42", host: "github.com", operation: "comment", args: [ref, "hello"] }, principal("a-device"))).rejects.toThrow();
    expect(p.localWrite).not.toHaveBeenCalled();
    expect(p.remoteWrite).not.toHaveBeenCalled();
  });
  it("never retries a remote mutation whose outcome is uncertain", async () => {
    const p = await pair();
    await p.grant("act");
    p.remoteWrite.mockRejectedValueOnce(new Error("Connection lost after dispatch"));
    await expect(p.registryA.invoke(ID, "test-comment")).rejects.toThrow("Connection lost after dispatch");
    expect(p.remoteWrite).toHaveBeenCalledTimes(1);
    expect(p.localWrite).not.toHaveBeenCalled();
    expect(p.callsA.mock.calls.filter((call) => call[2] === "github-sharing-act")).toHaveLength(1);
  });
  it("never routes after a local mutation starts", async () => {
    const p = await pair();
    await p.grant("act");
    p.localDetail.mockResolvedValueOnce({ title: "Local PR" } as never);
    p.localWrite.mockRejectedValueOnce(new Error("Unknown local mutation outcome"));
    await expect(p.registryA.invoke(ID, "test-comment")).rejects.toThrow("Unknown local mutation outcome");
    expect(p.remoteWrite).not.toHaveBeenCalled();
  });
  it("rejects reflected, unsupported and mutation-through-read requests", async () => {
    const p = await pair();
    await p.grant("act");
    const input = { source: "a", account: "42", host: "github.com", operation: "comment", args: [ref, "hello"] };
    await expect(p.registryB.invoke(ID, "github-sharing-read", input, principal("a-device"))).rejects.toThrow("not permitted");
    await expect(p.registryB.invoke(ID, "github-sharing-act", { ...input, source: "b" }, principal("a-device"))).rejects.toThrow("different source");
    await expect(p.registryB.invoke(ID, "github-sharing-act", { ...input, operation: "create" }, principal("a-device"))).rejects.toThrow("not permitted");
    await expect(p.registryB.invoke(ID, "github-sharing-act", { ...input, args: [{ ...ref, host: "evil.example" }, "hello"] }, principal("a-device"))).rejects.toThrow("Invalid GitHub");
    expect(p.remoteWrite).not.toHaveBeenCalled();
  });
  it("clears endpoint and key consent and blocks expired or removed devices", async () => {
    const p = await pair();
    await p.grant();
    p.machinesA[0]!.trustIdentity = "replacement-key";
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    expect(await p.registryA.invoke(ID, "github-sharing")).toEqual(expect.arrayContaining([expect.objectContaining({ id: "b", mode: "off" })]));
    p.devicesB.splice(0);
    await expect(p.registryB.invoke(ID, "github-sharing-read", { source: "a", account: "42", host: "github.com", operation: "detail", args: [ref, true] }, principal("a-device"))).rejects.toThrow("sharing is off");
  });
  it("requires action consent and a Full host connection", async () => {
    const p = await pair();
    await p.grant("read");
    await expect(p.registryA.invoke(ID, "test-comment")).rejects.toThrow("Local read unavailable");
    p.machinesA[0]!.readOnly = true;
    await expect(p.grant("act")).rejects.toThrow("Read only host");
    expect(p.remoteWrite).not.toHaveBeenCalled();
    expect(p.localWrite).not.toHaveBeenCalled();
  });
  it("uses the explicitly chosen action host before any local write", async () => {
    const p = await pair();
    await p.grant("act", true);
    p.localDetail.mockResolvedValue({ title: "Local readable PR" } as never);
    await p.registryA.invoke(ID, "test-comment");
    expect(p.remoteWrite).toHaveBeenCalledTimes(1);
    expect(p.localWrite).not.toHaveBeenCalled();
    p.machinesA[0]!.status = "offline";
    await expect(p.registryA.invoke(ID, "test-comment")).rejects.toThrow("No action was sent");
    expect(p.localWrite).not.toHaveBeenCalled();
  });
  it("routes API-only merge, auto-merge, revert and stack actions once", async () => {
    const p = await pair();
    await p.grant("act", true);
    for (const command of ["test-merge", "test-auto-merge", "test-revert", "test-stack-action"]) await p.registryA.invoke(ID, command);
    expect(p.remoteWrite).toHaveBeenCalledTimes(4);
    expect(p.localWrite).not.toHaveBeenCalled();
  });
  it("keeps approvals across restart and persists account-change revocation", async () => {
    const p = await pair();
    await p.grant();
    await p.registryA.deactivate(ID);
    await p.registryB.deactivate(ID);
    await p.registryA.activateKnown(ID);
    await p.registryB.activateKnown(ID);
    await expect(p.registryA.invoke(ID, "test-detail")).resolves.toEqual({ title: "Remote PR" });
    p.accountB(99);
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("different GitHub account");
    await p.registryA.deactivate(ID);
    p.accountB(42);
    await p.registryA.activateKnown(ID);
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    expect(await p.registryA.invoke(ID, "github-sharing")).toEqual(expect.arrayContaining([expect.objectContaining({ id: "b", mode: "off" })]));
  });
  it("clears consent after an endpoint change or disabling the host", async () => {
    const p = await pair();
    await p.grant();
    p.machinesA[0]!.address = "https://replacement-endpoint";
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    expect(await p.registryA.invoke(ID, "github-sharing")).toEqual(expect.arrayContaining([expect.objectContaining({ id: "b", mode: "off" })]));
    await p.grant();
    p.machinesA.splice(0);
    await expect(p.registryA.invoke(ID, "test-detail")).rejects.toThrow("Local read unavailable");
    expect(await p.registryA.invoke(ID, "github-sharing")).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: "b" })]));
  });
  it("lets only the owner change sharing", async () => {
    const p = await pair();
    await expect(p.registryA.invoke(ID, "github-sharing-set", { id: "b", direction: "machine", host: "github.com", mode: "act" }, principal("b-device"))).rejects.toThrow();
  });
});
