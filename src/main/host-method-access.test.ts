import { describe, expect, it, vi } from "vitest";
import { HOST_ERROR } from "../shared/host-transport.js";
import { HOST_METHOD_ACCESS, HOST_METHOD_AUDIT, MACHINE_REQUEST_METHODS, auditedMethodCall, authorizeMethod, isMachineRequestMethod, methodAccess } from "./host-method-access.js";
import { createHostMethods, createUnsupportedHostMethods, invokeHostMethod } from "./host-methods.js";
import { HostJobRunner } from "./host-jobs.js";
import type { HostInvocationPrincipal } from "./host-invocation.js";

const refuse = (): never => { throw Object.assign(new Error("the handler ran"), { code: "handler-ran" }); };

/** The real table, every dependency refusing: a call that reaches its handler says so. */
function methods() {
  const jobs = new HostJobRunner(() => undefined);
  const start = vi.spyOn(jobs, "start");
  const table = createHostMethods({
    bootstrap: refuse,
    requireHost: refuse,
    host: () => undefined,
    jobs,
    platform: {
      copyText: refuse, copyImage: refuse, readImagePreview: refuse, inspectExtensions: refuse, loadDesktopExtensions: refuse,
      rebuildWorkbench: refuse, workbenchSource: refuse, relaunchWorkbench: refuse, installUpdate: refuse, notify: refuse, setBadge: refuse,
    },
  });
  return { table, start };
}

const audit = vi.fn();
const readOnly: HostInvocationPrincipal = { kind: "workbench-client", connection: "c1", pairedClient: "p1", readOnly: true, audit };
const full: HostInvocationPrincipal = { kind: "workbench-client", connection: "c2", pairedClient: "p2", audit };
const owner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c3", local: true };
// The host token through a LAN or proxy listener: it uses the host but manages nothing.
const remoteOwner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c4" };

describe("the access every host method needs", () => {
  it("is declared for every method the host has, and nothing else", () => {
    const names = [...Object.keys(createUnsupportedHostMethods("x")), "host.shutdown"].sort();
    expect(Object.keys(HOST_METHOD_ACCESS).sort()).toEqual(names);
    // Anything new counts as a change until someone says otherwise.
    expect(methodAccess("a-method-added-later")).toBe("write");
  });

  it("refuses a Read-only device every method that changes something, before its handler runs", async () => {
    const { table } = methods();
    const writes = Object.entries(HOST_METHOD_ACCESS).filter(([, access]) => access !== "read").map(([name]) => name).filter((name) => name in table);
    expect(writes.length).toBeGreaterThan(40);
    for (const method of writes) {
      await expect(invokeHostMethod(table, method, [], readOnly), method).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    }
  });

  it("refuses the same through a job, before the job starts", async () => {
    const { table, start } = methods();
    for (const method of ["prompt", "update-config", "rebuild-workbench", "connections-list"]) {
      await expect(invokeHostMethod(table, "start-job", [method, []], readOnly), method).rejects.toMatchObject({ code: HOST_ERROR.forbidden });
    }
    expect(start).not.toHaveBeenCalled();
  });

  it("lets a Read-only device look", async () => {
    const { table } = methods();
    // It reaches the handler, which refuses for its own reason here.
    for (const method of ["bootstrap", "transcript-page", "thread-tree", "switch-session"]) {
      await expect(invokeHostMethod(table, method, [], readOnly), method).rejects.not.toMatchObject({ code: HOST_ERROR.forbidden });
    }
  });

  it("keeps access management from every paired device and records what each changed", () => {
    audit.mockClear();
    expect(() => authorizeMethod(full, "connections-approve")).toThrow(/host token/u);
    expect(() => authorizeMethod(owner, "connections-approve")).not.toThrow();
    for (const method of ["connections-approve", "connections-set-network", "connections-rotate-host-token", "host.shutdown"]) {
      expect(() => authorizeMethod(remoteOwner, method), method).toThrow(/on this machine/u);
    }
    expect(() => authorizeMethod(remoteOwner, "prompt")).not.toThrow();
    // The in-process window has no socket connection and is on this machine by construction.
    expect(() => authorizeMethod({ kind: "workbench-client" }, "connections-list")).not.toThrow();
    expect(() => authorizeMethod(full, "prompt")).not.toThrow();
    expect(() => authorizeMethod(full, "bootstrap")).not.toThrow();
    expect(() => authorizeMethod(readOnly, "prompt")).toThrow(/Read only/u);
    expect(audit.mock.calls.map(([call, allowed]) => [call.action, allowed])).toEqual([["connections-approve", false], ["prompt", true], ["prompt", false]]);
  });

  it("names every change a device can make the way a person reads it", () => {
    const changes = Object.entries(HOST_METHOD_ACCESS).filter(([, access]) => access === "write").map(([name]) => name).sort();
    expect(Object.keys(HOST_METHOD_AUDIT).sort()).toEqual(changes);
    expect(auditedMethodCall("prompt", ["the text", [], "s-1"])).toEqual({ action: "prompt", label: "sent a prompt", threadId: "s-1" });
    expect(auditedMethodCall("rename-thread", ["New title", "s-2"])).toEqual({ action: "rename-thread", label: "renamed a thread", threadId: "s-2" });
    // Sent on the way to a prompt, not a change of its own.
    expect(auditedMethodCall("prepare-prompt", ["text", "s-1"])).toMatchObject({ automatic: true, threadId: "s-1" });
    expect(auditedMethodCall("a-method-added-later")).toEqual({ action: "a-method-added-later" });
  });

  it("records the thread a call names, also through a job", async () => {
    const { table } = methods();
    audit.mockClear();
    await invokeHostMethod(table, "start-job", ["abort", ["s-3"]], full).catch(() => undefined);
    expect(audit.mock.calls).toEqual([[{ action: "abort", label: "stopped a run", threadId: "s-3" }, true]]);
  });

  it("leaves the host's own calls alone", () => {
    expect(() => authorizeMethod({ kind: "host-core" }, "prompt")).not.toThrow();
  });
});

describe("what one host may ask another for its agents (ADR 0027)", () => {
  it("is a short list of thread methods, never access management, jobs, subscriptions or a kit command", () => {
    for (const method of MACHINE_REQUEST_METHODS) expect(HOST_METHOD_ACCESS[method], method).not.toBe("owner");
    for (const method of ["connections-approve", "connections-list", "machines-add", "host.shutdown", "start-job", "subscribe", "host-extension", "environments-open", "prompt"]) {
      expect(isMachineRequestMethod(method), method).toBe(false);
    }
    expect(isMachineRequestMethod("transcript-page")).toBe(true);
    expect(isMachineRequestMethod("abort")).toBe(true);
    // How busy and how ready a machine is: read, and what an automatic choice of machine weighs.
    for (const method of ["host-resources", "readiness"]) {
      expect(isMachineRequestMethod(method), method).toBe(true);
      expect(methodAccess(method), method).toBe("read");
    }
  });

  it("keeps the machines' keys to the host token on this machine", () => {
    for (const method of ["machines-list", "machines-add", "machines-remove", "machines-overview", "machines-pair", "machines-forget"]) {
      expect(methodAccess(method), method).toBe("owner");
      expect(() => authorizeMethod(full, method), method).toThrow(/host token/u);
      expect(() => authorizeMethod(owner, method), method).not.toThrow();
    }
  });
});
