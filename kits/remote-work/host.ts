import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HostCommandError, type HostCommandCall, type HostExtension, type HostExtensionContext, type HostExtensionServices } from "tau/host-extension";
import { worktreeSetupCommand } from "../workspace/agent-worktrees.js";
import { HostedThreads } from "./hosted-threads.js";
import { REPO_KEY } from "./identity.js";
import { writeIgnoredFiles } from "./ignored-files.js";
import { MirrorStore, TRANSFER_ID } from "./mirror.js";
import { Operations, type OperationStep } from "./operations.js";
import {
  DEFAULT_REMOTE_WAIT_MS,
  HOSTED_COMMANDS,
  HOSTED_THREAD_EVENT,
  OPERATION_EVENT,
  PROJECT_SCRIPTS_EXTENSION_ID,
  RECEIVING_COMMANDS,
  REMOTE_WORK_EXTENSION_ID,
  REMOTE_WORK_PROTOCOL,
  TRANSFER_CALLERS,
  TRANSFER_EVENT,
  THREAD_LINK_EVENT,
  WORKTREE_CREATED_COMMAND,
  hostedThreadTopic,
  operationTopic,
  type HostedThreadStartInput,
  type IgnoredFilePayload,
  type ReceiveResult,
  type RemoteThreadDelivery,
  type RemoteThreadModel,
  type RemoteThreadStartInput,
  type RepoIdentity,
  type SendRepoInput,
  type SetupRun,
  type TransferStep,
} from "./protocol.js";
import { RemoteThreads } from "./threads.js";
import { RepoTransfers } from "./transfers.js";

const execFileAsync = promisify(execFile);

export interface RemoteWorkHostOptions {
  /** The receiving side's folder; `~/.tau/remote-work` by default. */
  root?: string;
  env?: NodeJS.ProcessEnv;
  pollMs?: number;
}

type Fields = Record<string, unknown>;
const fields = (input: unknown): Fields => (input && typeof input === "object" && !Array.isArray(input) ? input as Fields : {});
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);

function required(input: Fields, key: string): string {
  const value = text(input[key]);
  if (!value) throw new HostCommandError(`${key} is missing.`);
  return value;
}

function transferId(input: unknown): string {
  const id = required(fields(input), "transfer");
  if (!TRANSFER_ID.test(id)) throw new HostCommandError(`"${id}" is not a transfer id.`);
  return id;
}

function decodeSend(input: unknown): SendRepoInput {
  const raw = fields(input);
  const ignored = raw.ignored;
  if (ignored !== undefined && (!Array.isArray(ignored) || ignored.some((path) => typeof path !== "string"))) throw new HostCommandError("ignored is a list of paths.");
  return {
    machine: required(raw, "machine"),
    cwd: required(raw, "cwd"),
    ...(text(raw.name) ? { name: text(raw.name) } : {}),
    ...(text(raw.snapshotRef) ? { snapshotRef: text(raw.snapshotRef) } : {}),
    ...(Array.isArray(ignored) ? { ignored: ignored as string[] } : {}),
  };
}

function decodeRepo(value: unknown): RepoIdentity {
  const raw = fields(value);
  const key = required(raw, "key");
  if (!REPO_KEY.test(key)) throw new HostCommandError(`"${key}" is not a project key this machine takes.`);
  return {
    key,
    name: required(raw, "name"),
    source: raw.source === "root-commit" ? "root-commit" : "origin",
    ...(text(raw.origin) ? { origin: text(raw.origin) } : {}),
  };
}

function decodeModel(value: unknown): RemoteThreadModel | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") {
    const at = value.indexOf("/");
    if (at > 0 && at < value.length - 1) return { provider: value.slice(0, at), id: value.slice(at + 1) };
  }
  const raw = fields(value);
  const provider = text(raw.provider);
  const id = text(raw.id);
  if (!provider || !id) throw new HostCommandError('model is "provider/model-id" or { provider, id }.');
  return { provider, id };
}

function optionalText(raw: Fields, key: string): string | undefined {
  if (raw[key] !== undefined && raw[key] !== null && typeof raw[key] !== "string") throw new HostCommandError(`${key} is text.`);
  return text(raw[key]);
}

function decodeThreadStart(input: unknown): RemoteThreadStartInput {
  const raw = fields(input);
  const prompt = optionalText(raw, "prompt");
  const session = raw.session === undefined ? undefined : { threadId: required(fields(raw.session), "threadId") };
  if (!prompt && !session) throw new HostCommandError("A thread needs a prompt or a session to start from.");
  const ignored = raw.ignored;
  if (ignored !== undefined && (!Array.isArray(ignored) || ignored.some((path) => typeof path !== "string"))) throw new HostCommandError("ignored is a list of paths.");
  const model = decodeModel(raw.model);
  const optional = Object.fromEntries((["title", "backend", "parentThreadId", "agent", "snapshotRef"] as const)
    .map((key) => [key, optionalText(raw, key)] as const)
    .filter((entry): entry is readonly [typeof entry[0], string] => Boolean(entry[1])));
  return {
    machine: required(raw, "machine"),
    cwd: required(raw, "cwd"),
    ...(prompt ? { prompt } : {}),
    ...(session ? { session } : {}),
    ...(model ? { model } : {}),
    ...(Array.isArray(ignored) ? { ignored: ignored as string[] } : {}),
    ...optional,
  };
}

const DELIVERIES: readonly RemoteThreadDelivery[] = ["prompt", "steer", "queue"];

function decodeDelivery(value: unknown): RemoteThreadDelivery {
  if (value === undefined || value === null) return "prompt";
  if (!DELIVERIES.includes(value as RemoteThreadDelivery)) throw new HostCommandError(`delivery is one of ${DELIVERIES.join(", ")}.`);
  return value as RemoteThreadDelivery;
}

const linkId = (input: unknown) => required(fields(input), "link");

function decodeHostedStart(input: Fields): HostedThreadStartInput {
  const prompt = optionalText(input, "prompt");
  const rawSession = input.session === undefined ? undefined : fields(input.session);
  // Byte for byte: a session file is not trimmed.
  if (rawSession && (typeof rawSession.jsonl !== "string" || !rawSession.jsonl)) throw new HostCommandError("session.jsonl is missing.");
  const session = rawSession ? {
    jsonl: rawSession.jsonl as string,
    origin: { hostId: required(fields(rawSession.origin), "hostId"), threadId: required(fields(rawSession.origin), "threadId") },
  } : undefined;
  if (!prompt && !session) throw new HostCommandError("A thread needs a prompt or a session to start from.");
  const model = decodeModel(input.model);
  const title = optionalText(input, "title");
  const backend = optionalText(input, "backend");
  return {
    protocol: REMOTE_WORK_PROTOCOL,
    transfer: transferId(input),
    ...(prompt ? { prompt } : {}),
    ...(session ? { session } : {}),
    ...(title ? { title } : {}),
    ...(backend ? { backend } : {}),
    ...(model ? { model } : {}),
  };
}

/** A Pi thread's session file here, the one `thread-start({ session })` sends along. */
async function readPiSession(services: HostExtensionServices, threadId: string): Promise<string> {
  const live = services.thread(threadId);
  if (live && live.backendKind !== "pi") throw new HostCommandError("Only a Pi thread's session goes along; start the thread there with a prompt instead.");
  const path = live?.sessionFile ?? (await services.sessions.list()).find((session) => session.sessionId === threadId)?.path;
  if (!path?.endsWith(".jsonl")) throw new HostCommandError(`This machine has no Pi session for thread ${threadId}.`);
  return readFile(path, "utf8");
}

function checkProtocol(input: Fields): void {
  if (input.protocol !== REMOTE_WORK_PROTOCOL) {
    throw new HostCommandError(`This machine speaks Remote Work protocol ${REMOTE_WORK_PROTOCOL}, the caller ${String(input.protocol ?? "none")}; update Tau on both to the same version.`);
  }
}

const pending = (steps: ReadonlyArray<[TransferStep["id"], string]>): TransferStep[] => steps.map(([id, label]) => ({ id, label, state: "pending" }));

/**
 * The new worktree's setup, as Workspace Kit runs it for one here: Project
 * Scripts' `runOnWorktreeCreate` scripts, or without that kit the project's
 * old `runOnWorktreeCreate` line. A failed script is reported, never undone.
 */
async function runSetup(context: HostExtensionContext, worktree: string, step: OperationStep): Promise<SetupRun[]> {
  step("setup", "running");
  try {
    const answer = fields(await context.invokeHostExtension(PROJECT_SCRIPTS_EXTENSION_ID, WORKTREE_CREATED_COMMAND, { project: worktree, worktree }));
    const runs: SetupRun[] = (Array.isArray(answer.runs) ? answer.runs : []).map((run) => {
      const entry = fields(run);
      return { name: String(entry.name ?? entry.scriptId ?? "script"), status: String(entry.status ?? "unknown"), ...(typeof entry.exitCode === "number" ? { exitCode: entry.exitCode } : {}) };
    });
    if (runs.length === 0) step("setup", "skipped", "The project has no setup scripts");
    else step("setup", runs.some((run) => run.status === "failed") ? "failed" : "done", runs.map((run) => `${run.name}: ${run.status}`).join(", "));
    return runs;
  } catch (error) {
    context.services.log("remote-work.setup-fallback", error instanceof Error ? error.message : String(error));
  }
  let line: string | undefined;
  try {
    const raw = JSON.parse(await readFile(join(worktree, ".tau", "project.json"), "utf8")) as Fields;
    line = text(raw.runOnWorktreeCreate);
  } catch {
    line = undefined;
  }
  if (!line) {
    step("setup", "skipped", "The project has no setup");
    return [];
  }
  context.services.noteSubprocess();
  const setup = worktreeSetupCommand(line);
  try {
    await execFileAsync(setup.command, setup.args, {
      windowsVerbatimArguments: setup.windowsVerbatimArguments,
      windowsHide: true,
      cwd: worktree,
      timeout: 10 * 60_000,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, TAU_PROJECT_ROOT: worktree, TAU_WORKTREE_PATH: worktree },
    });
    step("setup", "done", line);
    return [{ name: line, status: "succeeded", exitCode: 0 }];
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    step("setup", "failed", `${line}: exit ${String(code ?? "?")}`);
    return [{ name: line, status: "failed", ...(typeof code === "number" ? { exitCode: code } : {}) }];
  }
}

/**
 * Remote Work Kit's host half (plan-H §2, ADR 0027). It is both sides at once:
 * here it sends a checkout's state to another machine and brings the result
 * back as a branch; there — the same kit on the other machine — it keeps the
 * mirror, the worktree and the result bundle. The sending side drives every
 * step, so the receiving side never needs to reach it.
 */
export function createRemoteWorkHostExtension(options: RemoteWorkHostOptions = {}): HostExtension {
  return {
    id: REMOTE_WORK_EXTENSION_ID,
    name: "Remote Work",
    permissions: ["machines", "workspace:read", "workspace:write", "process", "sessions", "runtime:extend"],
    isolation: "in-process",
    async activate(context) {
      const { services } = context;
      const transfers = new RepoTransfers({
        machines: () => services.machines,
        stateDir: services.stateDir,
        emit: (transfer) => context.emit(TRANSFER_EVENT, transfer),
        log: (label, detail) => services.log(label, detail),
        ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      });
      const mirrors = new MirrorStore({ stateDir: services.stateDir, ...(options.root ? { root: options.root } : {}), ...(options.env ? { env: options.env } : {}) });
      const operations = new Operations({ emit: (snapshot) => context.emit(OPERATION_EVENT, snapshot, { topic: operationTopic(snapshot.id) }) });
      const hosted = new HostedThreads({
        services,
        stateDir: services.stateDir,
        emit: (report) => context.emit(HOSTED_THREAD_EVENT, report, { topic: hostedThreadTopic(report.thread) }),
      });

      // Here: the sending side, for this machine's clients and the kits that start work elsewhere.
      const kits = { callers: TRANSFER_CALLERS };
      const rootOf = async (input: unknown) => {
        const cwd = text(fields(input).cwd);
        return cwd ? { root: await transfers.rootOf(cwd) } : {};
      };
      context.registerCommand("send", (input) => transfers.send(decodeSend(input)), { long: true, ...kits, audit: { label: "sent a project's state to another machine" } });
      context.registerCommand("transfers", async (input) => transfers.list(await rootOf(input)), { access: "read", ...kits });
      context.registerCommand("transfer", (input) => transfers.get(transferId(input)), { access: "read", ...kits });
      context.registerCommand("fetch-result", (input) => transfers.fetchResult(transferId(input)), { long: true, ...kits, audit: { label: "brought back work from another machine" } });
      context.registerCommand("preview", (input) => transfers.preview(transferId(input)), { access: "read", ...kits });
      context.registerCommand("apply", (input) => transfers.apply(transferId(input)), { long: true, ...kits, audit: { label: "merged work from another machine" } });
      context.registerCommand("discard", (input) => transfers.discard(transferId(input)), { long: true, ...kits, audit: { label: "let go of work on another machine" } });
      context.registerCommand("ignored-files", (input) => transfers.ignoredFiles(required(fields(input), "cwd")), { access: "read" });
      context.registerCommand("set-ignored-files", (input) => {
        const raw = fields(input);
        if (!Array.isArray(raw.paths)) throw new HostCommandError("paths is a list.");
        return transfers.setIgnoredFiles(required(raw, "cwd"), raw.paths as string[]);
      }, { audit: { label: "chose the ignored files that go along to other machines" } });

      // There: the receiving side, for the sending side's host through services.machines.
      const device = (call?: HostCommandCall) => call?.device;
      context.registerCommand(RECEIVING_COMMANDS.prepare, (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        const repo = decodeRepo(raw.repo);
        const operation = operations.start("prepare", device(call), pending([["mirror", "Mirror"]]), async (step) => {
          step("mirror", "running");
          const prepared = await mirrors.prepare(repo, step);
          step("mirror", "done", prepared.detail);
          return { protocol: prepared.protocol, tips: prepared.tips, mirror: prepared.mirror };
        });
        return { operation: operation.id, protocol: REMOTE_WORK_PROTOCOL };
      }, { audit: { label: "prepared a mirror for another machine's work", automatic: true } });

      context.registerCommand(RECEIVING_COMMANDS.receive, (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        const transfer = transferId(raw);
        const repo = decodeRepo(raw.repo);
        const base = required(raw, "base");
        const blob = raw.blob === undefined ? undefined : { id: required(fields(raw.blob), "id"), sha256: required(fields(raw.blob), "sha256") };
        const files = Array.isArray(raw.files) ? raw.files as IgnoredFilePayload[] : [];
        if (blob && !services.blobs) throw new HostCommandError("This host takes no files from other machines.");
        const steps = pending([["unpack", "Unpack"], ["worktree", "Worktree"], ["files", "Ignored files"], ["setup", "Setup"]]);
        const operation = operations.start("receive", device(call), steps, async (step): Promise<ReceiveResult> => {
          const receive = (bundle?: string) => mirrors.receive({ transfer, repo, base, ...(bundle ? { bundle } : {}), ...(device(call) ? { device: device(call) } : {}) }, step);
          const entry = blob
            ? await services.blobs!.take(blob.id, (file) => {
              if (file.sha256 !== blob.sha256) throw new Error("The bundle here has another checksum than the one sent.");
              return receive(file.path);
            }, { caller: call })
            : await receive();
          if (files.length === 0) step("files", "skipped", "None chosen for this project");
          else {
            step("files", "running");
            const written = await writeIgnoredFiles(entry.worktree, files);
            step("files", written.refused.length > 0 ? "failed" : "done", `${written.written} written${written.refused.length > 0 ? `; refused ${written.refused.join(", ")}` : ""}`);
          }
          const workspace = services.admitWorkspace(entry.worktree);
          await mirrors.remember(transfer, { workspaceId: workspace.workspaceId });
          const setup = await runSetup(context, entry.worktree, step);
          services.log("remote-work.received", `${transfer} ${entry.worktree}`);
          return { worktree: entry.worktree, branch: entry.branch, base: entry.base, workspaceId: workspace.workspaceId, setup };
        });
        return { operation: operation.id, protocol: REMOTE_WORK_PROTOCOL };
      }, { audit: { label: "took on a project's state from another machine" } });

      context.registerCommand(RECEIVING_COMMANDS.result, async (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        const transfer = transferId(raw);
        await mirrors.get(transfer, device(call));
        const operation = operations.start("result", device(call), [], () => mirrors.result(transfer, device(call)));
        return { operation: operation.id, protocol: REMOTE_WORK_PROTOCOL };
      }, { audit: { label: "packed a worktree's work for another machine" } });

      context.registerCommand(RECEIVING_COMMANDS.download, async (input, call) => {
        const raw = fields(input);
        return { data: await mirrors.readResult(transferId(raw), device(call), Number(raw.offset), Number(raw.length)) };
      }, { access: "read" });

      context.registerCommand(RECEIVING_COMMANDS.remove, async (input, call) => {
        const transfer = transferId(input);
        if (hosted.busy(transfer)) throw new HostCommandError("A thread still works in that worktree; stop it first.");
        await mirrors.remove(transfer, device(call));
        return { removed: true };
      }, { audit: { label: "removed a worktree another machine had worked in" } });

      context.registerCommand(RECEIVING_COMMANDS.operation, (input, call) => operations.get(required(fields(input), "id"), device(call)), { access: "read" });

      // Threads, here: the service other kits and this machine's clients start and steer them with (H06).
      const threads = new RemoteThreads({
        machines: () => services.machines,
        transfers,
        readSession: (threadId) => readPiSession(services, threadId),
        stateDir: services.stateDir,
        emit: (link) => context.emit(THREAD_LINK_EVENT, link),
        log: (label, detail) => services.log(label, detail),
      });
      context.registerCommand("thread-start", (input) => threads.start(decodeThreadStart(input)), { long: true, ...kits, audit: { label: "started a thread on another machine" } });
      context.registerCommand("threads", (input) => {
        const raw = fields(input);
        return threads.list({ ...(text(raw.machine) ? { machine: text(raw.machine) } : {}), ...(text(raw.parentThreadId) ? { parentThreadId: text(raw.parentThreadId) } : {}), ...(raw.active === true ? { active: true } : {}) });
      }, { access: "read", ...kits });
      context.registerCommand("thread", (input) => threads.get(linkId(input)), { access: "read", ...kits });
      context.registerCommand("thread-send", (input) => {
        const raw = fields(input);
        return threads.send(linkId(input), required(raw, "text"), decodeDelivery(raw.delivery));
      }, { long: true, ...kits, audit: { label: "sent a message to a thread on another machine" } });
      context.registerCommand("thread-abort", (input) => threads.abort(linkId(input)), { long: true, ...kits, audit: { label: "stopped a thread on another machine" } });
      context.registerCommand("thread-wait", (input) => {
        const timeout = fields(input).timeoutMs;
        const ms = timeout === undefined ? DEFAULT_REMOTE_WAIT_MS : Number(timeout);
        if (!Number.isFinite(ms) || ms <= 0) throw new HostCommandError("timeoutMs is a positive number of milliseconds.");
        return threads.wait(linkId(input), ms);
      }, { long: true, access: "read", ...kits });
      context.registerCommand("thread-result", (input) => threads.fetchResult(linkId(input)), { long: true, ...kits, audit: { label: "brought back a thread's work from another machine" } });
      context.registerCommand("thread-settle", (input) => {
        const how = fields(input).how;
        if (how !== "apply" && how !== "discard") throw new HostCommandError('how is "apply" or "discard".');
        return threads.settle(linkId(input), how);
      }, { long: true, ...kits, audit: { label: "settled a thread's work from another machine" } });

      // Threads, there: what the sending side's host calls for the threads it starts here.
      context.registerCommand(HOSTED_COMMANDS.hello, () => ({ protocol: REMOTE_WORK_PROTOCOL }), { access: "read" });
      context.registerCommand(HOSTED_COMMANDS.start, async (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        const start = decodeHostedStart(raw);
        const entry = await mirrors.get(start.transfer, device(call));
        return hosted.start(start, entry.worktree, device(call));
      }, { audit: { label: "started a thread for another machine" } });
      context.registerCommand(HOSTED_COMMANDS.send, (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        return hosted.send(required(raw, "thread"), required(raw, "text"), decodeDelivery(raw.delivery), device(call));
      }, { audit: { label: "sent another machine's message to a thread" } });
      context.registerCommand(HOSTED_COMMANDS.abort, (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        return hosted.abort(required(raw, "thread"), device(call));
      }, { audit: { label: "stopped a thread for another machine" } });
      context.registerCommand(HOSTED_COMMANDS.reports, (input, call) => {
        const raw = fields(input);
        checkProtocol(raw);
        if (!Array.isArray(raw.threads) || raw.threads.some((thread) => typeof thread !== "string") || raw.threads.length > 500) throw new HostCommandError("threads is a list of up to 500 thread ids.");
        return { reports: hosted.reports(raw.threads as string[], device(call)) };
      }, { access: "read" });

      const disposers = [
        services.registerTurnObserver({
          accepted: (sessionId) => hosted.accepted(sessionId),
          ended: (sessionId, _turnId, outcome) => hosted.ended(sessionId, outcome),
          cancelled: async (sessionId) => hosted.cancelled(sessionId),
          closed: async (sessionId) => hosted.closed(sessionId),
        }),
        // A dialog the thread opens is answered there; the sending side learns that it waits and on what.
        services.registerRuntimeExtension("tau-remote-work", (pi, session) => {
          pi.on("ui_prompt_start", (event) => hosted.prompt(session.sessionId, event.title ?? event.kind));
          pi.on("ui_prompt_end", () => hosted.prompt(session.sessionId, undefined));
        }),
        services.registerThreadLifecycle({ threadDeleted: async (sessionId) => hosted.deleted(sessionId) }),
      ];
      await hosted.load();
      await threads.open();
      return async () => {
        threads.close();
        for (const dispose of disposers) dispose();
        await Promise.all([threads.flush(), hosted.flush()]);
      };
    },
  };
}

export default createRemoteWorkHostExtension;
