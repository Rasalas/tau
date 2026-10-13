import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import { PROJECT_APPROVAL_COMMAND, PROJECT_APPROVAL_EVENT, type ProjectApprovalRequest } from "../_project-file/setup-approval.js";
import { setupFingerprint } from "../_project-file/fingerprint.js";

interface Pending {
  request: ProjectApprovalRequest;
  fingerprint: string;
  answer: Promise<boolean>;
  resolve(approved: boolean): void;
  answering?: boolean;
}

export async function readSetupFile(project: string) {
  const text = await readFile(join(project, ".tau", "project.json"), "utf8");
  const raw = JSON.parse(text) as Record<string, unknown>;
  const commands: string[] = [];
  if (typeof raw.runOnWorktreeCreate === "string" && raw.runOnWorktreeCreate.trim()) commands.push(raw.runOnWorktreeCreate.trim());
  if (Array.isArray(raw.scripts)) {
    for (const script of raw.scripts as Array<Record<string, unknown> | null>) {
      if (script?.runOnWorktreeCreate === true && typeof script.command === "string" && script.command.trim()) commands.push(script.command.trim());
    }
  }
  return { text, fingerprint: setupFingerprint(text), commands };
}

/** Workspace owns approvals for both setup runners. Nothing is saved in the repository. */
export function registerProjectApprovals(context: HostExtensionContext) {
  const pending = new Map<string, Pending>();
  let disposed = false;
  const { services } = context;
  const pathOf = (project: string) => join(services.stateDir, "project-approvals", createHash("sha256").update(project).digest("hex") + ".json");
  const trusted = async (project: string, fingerprint: string): Promise<boolean> => {
    try { return JSON.parse(await readFile(pathOf(await realpath(project)), "utf8")) === fingerprint; }
    catch { return false; }
  };
  const list = () => [...pending.values()].map((entry) => entry.request);
  const changed = () => context.emit(PROJECT_APPROVAL_EVENT, list());
  const approve = async (project: string, fingerprint: string): Promise<boolean> => {
    project = await realpath(project);
    const current = await readSetupFile(project).catch(() => undefined);
    if (!current || current.fingerprint !== fingerprint) return false;
    const alreadyTrusted = await trusted(project, fingerprint);
    if (disposed) return false;
    if (alreadyTrusted) return true;
    if (!services.clients?.count()) return false;
    const existing = [...pending.values()].find((entry) => entry.request.project === project && entry.fingerprint === fingerprint);
    if (existing) return existing.answer;
    let resolve!: (approved: boolean) => void;
    const answer = new Promise<boolean>((done) => { resolve = done; });
    const request: ProjectApprovalRequest = { id: randomUUID(), project, commands: current.commands };
    pending.set(request.id, { request, fingerprint, answer, resolve });
    changed();
    return answer;
  };
  context.registerCommand(PROJECT_APPROVAL_COMMAND, async (input) => {
    const raw = input as { project?: unknown; fingerprint?: unknown } | undefined;
    if (typeof raw?.project !== "string" || typeof raw.fingerprint !== "string") throw new HostCommandError("Project approval needs a project and fingerprint.");
    return approve(await services.knownWorkspacePath(raw.project), raw.fingerprint);
  }, { long: true, callers: ["tau.project-scripts", "tau.remote-work"] });
  context.registerCommand("project-approvals", list, { access: "read" });
  context.registerCommand("answer-project-approval", async (input) => {
    const raw = input as { id?: unknown; approved?: unknown } | undefined;
    const entry = typeof raw?.id === "string" ? pending.get(raw.id) : undefined;
    if (!entry || entry.answering) return;
    entry.answering = true;
    let approved = false;
    try {
      const current = await readSetupFile(entry.request.project);
      if (raw?.approved === true && current.fingerprint === entry.fingerprint) {
        const path = pathOf(entry.request.project);
        await mkdir(join(services.stateDir, "project-approvals"), { recursive: true });
        await writeFile(path, JSON.stringify(entry.fingerprint), { mode: 0o600 });
        approved = !disposed && Boolean(services.clients?.count());
      }
    } catch (error) { services.log("project.approval-failed", String(error)); }
    entry.resolve(approved);
    pending.delete(entry.request.id);
    changed();
  });
  const unobserve = services.clients?.observe({
    detached: () => {
      if (services.clients.count() !== 0) return;
      for (const entry of pending.values()) entry.resolve(false);
      pending.clear();
    },
  }) ?? (() => undefined);
  return {
    trusted, approve,
    dispose: () => {
      disposed = true;
      unobserve();
      for (const entry of pending.values()) entry.resolve(false);
      pending.clear();
    },
  };
}
