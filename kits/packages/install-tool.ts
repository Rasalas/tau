import { randomUUID } from "node:crypto";
import { relative } from "node:path";
import { Type } from "typebox";
import { HostCommandError, type HostExtensionContext, type HostMcpTool, type PackageReview, type RuntimeSessionInfo } from "tau/host-extension";
import { INSTALL_REQUESTS_EVENT, INSTALL_TOOL, PACKAGE_STARTED_EVENT, type InstallRequest, type InstallRequestList, type PackageStarted } from "./install-protocol.js";

const DEFAULT_TIMEOUT_MS = 30 * 60_000;

type Answer = "running" | "declined" | "ended";

interface Waiting {
  request: InstallRequest;
  /** What the card showed; the grant only applies to a folder that still matches. */
  path: string;
  fingerprint: string;
  settle(answer: Answer): void;
  approving: boolean;
}

/** One entry per compile error: where, and what esbuild said. */
function buildErrors(review: PackageReview) {
  return review.buildErrors.flatMap((error) => error.diagnostics?.length
    ? error.diagnostics.map((diagnostic) => ({
      file: diagnostic.file ?? relative(review.directory, error.path),
      ...(diagnostic.line === undefined ? {} : { line: diagnostic.line }),
      ...(diagnostic.column === undefined ? {} : { column: diagnostic.column }),
      message: diagnostic.text,
    }))
    : [{ file: relative(review.directory, error.path), message: error.message }]);
}

function toolResult(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], details: value };
}

const idOf = (input: unknown): string => {
  const id = input && typeof input === "object" ? (input as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || !id) throw new HostCommandError("Name the request by its id.");
  return id;
};

/**
 * `tau_install_package`: scans a package folder the agent wrote into the global
 * extension folder, hands build errors back at once, and otherwise waits for
 * the user's answer on a card above the thread's composer. Only a package
 * `tau_new_package` made, in a thread at Full access, starts without the card
 * (the host checks both); every other grant is the owner command behind the
 * card's button, which asks the host to confirm in its native dialog.
 */
export class PackageInstalls {
  private readonly waiting = new Map<string, Waiting>();
  private readonly stops: Array<() => void> = [];

  constructor(private readonly context: HostExtensionContext, private readonly timeoutMs = DEFAULT_TIMEOUT_MS) {}

  list(): InstallRequest[] { return [...this.waiting.values()].map((entry) => ({ ...entry.request })); }

  private publish(): void { this.context.emit(INSTALL_REQUESTS_EVENT, { requests: this.list() }); }

  /** Ends what a thread still waits on: it stopped, closed or was deleted. */
  end(threadId: string): void {
    for (const entry of this.waiting.values()) if (entry.request.threadId === threadId) entry.settle("ended");
  }

  private async install(session: RuntimeSessionInfo, path: unknown, signal: AbortSignal | undefined) {
    if (typeof path !== "string" || !path.trim()) throw new HostCommandError("Name the package folder with `path`.");
    const review = await this.context.services.reviewPackage(path);
    if (review.buildErrors.length > 0) {
      return { status: "build_failed", id: review.id, errors: buildErrors(review), message: "The package does not build yet. Fix these errors and call tau_install_package again; nothing was shown to the user." };
    }
    if (review.granted) return { status: "running", id: review.id, message: runningMessage(review) };
    if (signal?.aborted) return { status: "ended", id: review.id };
    // At Full access the agent could write the grant itself, so a package it made starts without a card (ADR 0036).
    if (review.own && await this.context.services.startOwnPackage(path, review.fingerprint, session.sessionId)) {
      this.context.emit(PACKAGE_STARTED_EVENT, { threadId: session.sessionId, packageId: review.id, name: review.name, isolation: review.isolation } satisfies PackageStarted);
      return { status: "running", id: review.id, message: runningMessage(review) };
    }
    // A newer call for the same thread replaces the card it left.
    this.end(session.sessionId);

    const request: InstallRequest = {
      id: randomUUID(),
      threadId: session.sessionId,
      status: "pending",
      packageId: review.id,
      name: review.name,
      ...(review.version ? { version: review.version } : {}),
      ...(review.description ? { description: review.description } : {}),
      permissions: review.permissions,
      isolation: review.isolation,
      desktop: review.desktop,
      ...(review.previous ? { previous: review.previous } : {}),
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let cancel = () => undefined as void;
    const answer = new Promise<Answer>((resolve) => {
      const settle = (result: Answer) => {
        if (this.waiting.get(request.id)?.request !== request) return;
        this.waiting.delete(request.id);
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.publish();
        resolve(result);
      };
      cancel = () => settle("ended");
      this.waiting.set(request.id, { request, path, fingerprint: review.fingerprint, settle, approving: false });
      timer = setTimeout(cancel, this.timeoutMs);
      signal?.addEventListener("abort", cancel, { once: true });
    });
    this.publish();
    const status = await answer;
    return {
      status,
      id: review.id,
      message: status === "running" ? runningMessage(review)
        : status === "declined" ? `The user did not allow ${review.name}. It stays installed but off; they can still turn it on in Settings → Extensions.`
          : `The request for ${review.name} ended before the user answered. Call tau_install_package again to ask again.`,
    };
  }

  register(): void {
    const { context } = this;
    context.registerCommand("install-requests", (_input, call): InstallRequestList => ({ requests: this.list(), canManage: call.owner }), { access: "read" });
    context.registerCommand("allow-install", async (input) => {
      const entry = this.waiting.get(idOf(input));
      if (!entry) throw new HostCommandError("This request ended.");
      if (entry.approving) throw new HostCommandError("Confirmation is already open.");
      entry.approving = true;
      // The host asks for its native confirmation here and waits for the answer (ADR 0036).
      try {
        await context.services.approvePackage(entry.path, entry.fingerprint);
      } finally {
        entry.approving = false;
      }
      entry.settle("running");
      return { running: true };
    }, { access: "owner", long: true });
    context.registerCommand("decline-install", (input) => {
      this.waiting.get(idOf(input))?.settle("declined");
      return { declined: true };
    }, { access: "owner" });
    // The toast's "Turn off" for a package that started without a card.
    context.registerCommand("turn-off", async (input) => {
      await context.services.stopPackage(idOf(input));
      return { off: true };
    }, { access: "owner" });

    const tools = (session: RuntimeSessionInfo): HostMcpTool[] => [{
      // Changes nothing itself: only the user's card answer, or Full access, starts a package. The Access Kit's gate would otherwise ask twice.
      annotations: { readOnlyHint: true },
      name: INSTALL_TOOL,
      label: "Install package",
      description: "Install a Tau extension package from a folder inside the global extension folder (the one tau_new_package creates). Builds it and returns build errors with file, line and column. A package made with tau_new_package starts at once in a thread with Full access (the user sees a toast with Turn off). In any other thread, and for any package you did not make with tau_new_package, the user is asked in this thread what it may do, and only their confirmation starts it. Returns { status: running | declined | ended, id }.",
      promptSnippet: `${INSTALL_TOOL}: install a package you wrote; it starts at once at Full access, else the user is asked`,
      parameters: Type.Object({ path: Type.String({ description: "The package folder: its name inside the global extension folder, or its absolute path." }) }),
      execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal) => {
        const path = params && typeof params === "object" ? (params as { path?: unknown }).path : undefined;
        return toolResult(await this.install(session, path, signal));
      },
    }];
    this.stops.push(context.services.mcp.registerTools(tools));
    this.stops.push(context.services.registerRuntimeExtension("tau-install-package", (pi, session) => { for (const tool of tools(session)) pi.registerTool(tool); }));
    this.stops.push(context.services.registerThreadLifecycle({ threadDeleted: async (id) => { this.end(id); } }));
    this.stops.push(context.services.registerTurnObserver({ closed: async (id) => { this.end(id); } }));
  }

  close(): void {
    for (const entry of [...this.waiting.values()]) entry.settle("ended");
    for (const stop of this.stops.splice(0).reverse()) stop();
  }
}

function runningMessage(review: PackageReview): string {
  return review.own
    ? `${review.name} is running. Edits to its files load live without asking again. A change to its permissions or isolation turns it off until you call ${INSTALL_TOOL} again (at Full access it starts at once, otherwise the user is asked about what is new).`
    : `${review.name} is running. A change to any of its files turns it off until the user allows it again, so call ${INSTALL_TOOL} again after editing.`;
}
