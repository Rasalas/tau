import { lstat, realpath } from "node:fs/promises";
import { dirname, basename, isAbsolute, relative, resolve, sep } from "node:path";
import type { ComputerUseDriverConfig } from "./driver.js";

export interface ComputerUseConfig extends ComputerUseDriverConfig {
  confirmAppLaunch?: boolean;
  confirmDangerousActions?: boolean;
  visionModel?: { provider: string; model: string };
}
export interface ComputerUseConfirmation {
  title: string;
  message: string;
  signal?: AbortSignal;
}
export type ComputerUseConfirm = (request: ComputerUseConfirmation) => Promise<boolean>;
export interface ComputerUsePolicyOptions {
  cwd: string;
  config?: ComputerUseConfig;
  confirm?: ComputerUseConfirm;
}
export class ComputerUseApprovalError extends Error {
  constructor(message: string) { super(message); this.name = "ComputerUseApprovalError"; }
}
const HIGH_RISK_TOOLS = new Set([
  "browser_download", "browser_prepare", "browser_set_input_files", "install_ffmpeg",
  "kill_app", "replay_trajectory", "start_recording",
]);
function inside(root: string, candidate: string): boolean {
  const suffix = relative(root, candidate);
  return suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix));
}

/** Resolve future directories from their nearest existing ancestor, refusing escaped or final symlinks. */
export async function approvedRecordingDirectory(value: unknown, cwd: string): Promise<string | undefined> {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const root = resolve(cwd);
  const output = resolve(root, value);
  if (!inside(root, output)) return undefined;
  try {
    const canonicalRoot = await realpath(root);
    let ancestor = output;
    const suffix: string[] = [];
    for (;;) {
      let info;
      try { info = await lstat(ancestor); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
      }
      if (info) {
        if (!info.isDirectory() && !info.isSymbolicLink()) return undefined;
        if (ancestor === output && info.isSymbolicLink()) return undefined;
        const canonicalAncestor = await realpath(ancestor);
        // A symlink to a file cannot serve as a parent for a future directory.
        if (!(await lstat(canonicalAncestor)).isDirectory()) return undefined;
        const canonical = resolve(canonicalAncestor, ...suffix);
        return inside(canonicalRoot, canonical) ? canonical : undefined;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) return undefined;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  } catch { return undefined; }
}
function launchKey(args: Record<string, unknown>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(args).sort(([left], [right]) => left.localeCompare(right))));
}

/** Shared by Pi and MCP. Construct once for a thread to retain its launch approvals. */
export class ComputerUsePolicy {
  private readonly approvedLaunches = new Set<string>();
  private readonly config: ComputerUseConfig;
  constructor(private readonly options: ComputerUsePolicyOptions) {
    this.config = structuredClone(options.config ?? {});
  }

  private async confirm(title: string, message: string, signal: AbortSignal | undefined, confirm: ComputerUseConfirm | undefined): Promise<void> {
    signal?.throwIfAborted();
    if (!confirm) throw new ComputerUseApprovalError("Computer Use action requires interactive confirmation.");
    const pending = confirm({ title, message, signal });
    const approved = await new Promise<boolean>((accept, reject) => {
      const abort = () => reject(signal?.reason);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
      pending.then(accept, reject).finally(() => signal?.removeEventListener("abort", abort));
    });
    signal?.throwIfAborted();
    if (!approved) throw new ComputerUseApprovalError("Computer Use action was not approved.");
  }

  async approve(name: string, args: Record<string, unknown>, signal?: AbortSignal, confirm: ComputerUseConfirm | undefined = this.options.confirm): Promise<Record<string, unknown>> {
    signal?.throwIfAborted();
    const approvedArgs = structuredClone(args);
    if (name === "launch_app" && this.config.confirmAppLaunch !== false) {
      const key = launchKey(approvedArgs);
      if (!this.approvedLaunches.has(key)) {
        const target = approvedArgs.bundle_id ?? approvedArgs.aumid ?? approvedArgs.name ?? approvedArgs.app_name ?? approvedArgs.path ?? approvedArgs.command ?? "unknown app";
        await this.confirm("Allow computer use?", `Allow Computer Use to launch and control ${String(target)} for this session?`, signal, confirm);
        signal?.throwIfAborted();
        this.approvedLaunches.add(key);
      }
      return approvedArgs;
    }
    if (name === "start_recording") {
      const requested = approvedArgs.output_dir;
      const output = await approvedRecordingDirectory(requested, this.options.cwd);
      signal?.throwIfAborted();
      if (!output) throw new ComputerUseApprovalError("Recording output must be a directory inside this thread's workspace.");
      approvedArgs.output_dir = output;
      await this.confirm("Confirm computer recording", `Allow start_recording with arguments ${JSON.stringify(approvedArgs)}?`, signal, confirm);
      const rechecked = await approvedRecordingDirectory(requested, this.options.cwd);
      signal?.throwIfAborted();
      if (rechecked !== output) throw new ComputerUseApprovalError("Recording output directory changed during confirmation.");
      return approvedArgs;
    }
    if (HIGH_RISK_TOOLS.has(name) && this.config.confirmDangerousActions !== false) {
      await this.confirm("Confirm computer action", `Allow ${name} with arguments ${JSON.stringify(approvedArgs)}?`, signal, confirm);
    }
    signal?.throwIfAborted();
    return approvedArgs;
  }
}
