import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { HostExtensionServices } from "tau/host-extension";
import { activateHostKit } from "../../src/main/test-support/host-kit-harness.js";
import { PROJECT_APPROVAL_COMMAND, PROJECT_APPROVAL_EVENT, type ProjectApprovalRequest } from "../_project-file/setup-approval.js";
import { registerProjectApprovals, readSetupFile } from "./project-approval-host.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "tau-project-approval-"));
  roots.push(root);
  const project = join(root, "repo");
  await mkdir(join(project, ".tau"), { recursive: true });
  const save = (command: string) => writeFile(join(project, ".tau", "project.json"), JSON.stringify({
    workspaceMode: "worktree", runOnWorktreeCreate: "legacy-command",
    scripts: [{ name: "Install", command, runOnWorktreeCreate: true }],
  }));
  await save("first-command");
  const open = async (clients?: HostExtensionServices["clients"]) => {
    let requested!: (request: ProjectApprovalRequest) => void;
    const requests = new Promise<ProjectApprovalRequest>((resolve) => { requested = resolve; });
    const registry = await activateHostKit({
      id: "tau.workspace", name: "Project approval", permissions: ["workspace:read"],
      activate: (context) => registerProjectApprovals(context).dispose,
    }, {
      stateDir: join(root, "host-state"), knownWorkspacePath: async (path) => path,
      clients: clients ?? { count: () => 1, observe: () => () => undefined },
    }, (event) => {
      if (event.name === PROJECT_APPROVAL_EVENT) {
        const request = (event.payload as ProjectApprovalRequest[])[0];
        if (request) requested(request);
      }
    });
    const invoke = (command: string, input?: unknown) => registry.invoke("tau.workspace", command, input);
    const ask = async (path = project) => invoke(PROJECT_APPROVAL_COMMAND, { project: path, fingerprint: (await readSetupFile(path)).fingerprint });
    const answer = (request: ProjectApprovalRequest, approved: boolean) => invoke("answer-project-approval", { id: request.id, approved });
    return { registry, invoke, ask, answer, requests };
  };
  return { root, project, save, open };
}

describe("project setup approval", () => {
  it("does not let a setup runner approve its own request", async () => {
    const fixtureOf = await fixture();
    const kit = await fixtureOf.open();
    await kit.registry.activate({
      id: "tau.project-scripts", name: "Setup runner", permissions: [],
      activate: (context) => {
        context.registerCommand("answer", (input) => context.invokeHostExtension("tau.workspace", "answer-project-approval", input));
      },
    });
    try {
      const pending = kit.ask();
      const request = await kit.requests;
      await expect(kit.registry.invoke("tau.project-scripts", "answer", { id: request.id, approved: true })).rejects.toMatchObject({ code: "unauthorized" });
      expect(await kit.invoke("project-approvals")).toEqual([request]);
      await kit.answer(request, false);
      await expect(pending).resolves.toBe(false);
    } finally {
      await kit.registry.deactivate("tau.project-scripts");
      await kit.registry.deactivate("tau.workspace");
    }
  });

  it("shows all commands, skips a rejected setup, and asks again next time", async () => {
    const fixtureOf = await fixture();
    const kit = await fixtureOf.open();
    const first = kit.ask();
    const request = await kit.requests;
    expect(request.commands).toEqual(["legacy-command", "first-command"]);
    expect(await kit.invoke("project-approvals")).toEqual([request]);
    await kit.answer(request, false);
    await expect(first).resolves.toBe(false);
    await kit.registry.deactivate("tau.workspace");
    const reopened = await fixtureOf.open();
    const next = reopened.ask();
    const again = await reopened.requests;
    expect(again.id).not.toBe(request.id);
    await reopened.answer(again, false);
    await expect(next).resolves.toBe(false);
    await reopened.registry.deactivate("tau.workspace");
  });

  it("retains approval across restarts and path aliases, but changed commands need approval again", async () => {
    const fixtureOf = await fixture();
    const kit = await fixtureOf.open();
    const first = kit.ask();
    await kit.answer(await kit.requests, true);
    await expect(first).resolves.toBe(true);
    await kit.registry.deactivate("tau.workspace");
    const reopened = await fixtureOf.open();
    const alias = join(fixtureOf.root, "alias");
    await symlink(fixtureOf.project, alias);
    await expect(reopened.ask(alias)).resolves.toBe(true);
    await fixtureOf.save("changed-command");
    const changed = reopened.ask();
    const request = await reopened.requests;
    expect(request.commands).toContain("changed-command");
    await reopened.answer(request, false);
    await expect(changed).resolves.toBe(false);
    await reopened.registry.deactivate("tau.workspace");
  });

  it("refuses approval if the file changed while the question was open", async () => {
    const fixtureOf = await fixture();
    const kit = await fixtureOf.open();
    const pending = kit.ask();
    const request = await kit.requests;
    await fixtureOf.save("replacement-command");
    await kit.answer(request, true);
    await expect(pending).resolves.toBe(false);
    await kit.registry.deactivate("tau.workspace");
  });

  it("does not grant another project approval for identical commands", async () => {
    const fixtureOf = await fixture();
    const kit = await fixtureOf.open();
    const first = kit.ask();
    await kit.answer(await kit.requests, true);
    await expect(first).resolves.toBe(true);
    await kit.registry.deactivate("tau.workspace");
    const other = join(fixtureOf.root, "other");
    await mkdir(join(other, ".tau"), { recursive: true });
    await writeFile(join(other, ".tau", "project.json"), (await readSetupFile(fixtureOf.project)).text);
    const reopened = await fixtureOf.open();
    const pending = reopened.ask(other);
    await reopened.answer(await reopened.requests, false);
    await expect(pending).resolves.toBe(false);
    await reopened.registry.deactivate("tau.workspace");
  });

  it("releases requests when the kit deactivates", async () => {
    const fixtureOf = await fixture();
    const kit = await fixtureOf.open();
    const pending = kit.ask();
    await kit.requests;
    expect(await kit.invoke("project-approvals")).toHaveLength(1);
    await kit.registry.deactivate("tau.workspace");
    await expect(pending).resolves.toBe(false);
  });

  it("skips setup without a workbench and releases a question when the last client disconnects", async () => {
    const fixtureOf = await fixture();
    let count = 0;
    let detached: (() => void) | undefined;
    const kit = await fixtureOf.open({ count: () => count, observe: (observer) => { detached = () => observer.detached?.("window"); return () => undefined; } });
    await expect(kit.ask()).resolves.toBe(false);
    count = 1;
    const pending = kit.ask();
    await kit.requests;
    count = 0;
    detached?.();
    await expect(pending).resolves.toBe(false);
    expect(await kit.invoke("project-approvals")).toEqual([]);
    await kit.registry.deactivate("tau.workspace");
  });
});
