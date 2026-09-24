import { describe, expect, it, vi } from "vitest";
import { HOST_ERROR } from "../shared/host-transport.js";
import { HOST_METHOD_ACCESS, authorizeMethod, methodAccess } from "./host-method-access.js";
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
const owner: HostInvocationPrincipal = { kind: "workbench-client", connection: "c3" };

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
    expect(() => authorizeMethod(full, "prompt")).not.toThrow();
    expect(() => authorizeMethod(full, "bootstrap")).not.toThrow();
    expect(() => authorizeMethod(readOnly, "prompt")).toThrow(/Read only/u);
    expect(audit.mock.calls).toEqual([["connections-approve", false], ["prompt", true], ["prompt", false]]);
  });

  it("leaves the host's own calls alone", () => {
    expect(() => authorizeMethod({ kind: "host-core" }, "prompt")).not.toThrow();
  });
});
