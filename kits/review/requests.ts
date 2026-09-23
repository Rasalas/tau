import type { HostExtensionClient, UiReviewRequestChecks } from "tau";
import { providerInfo, type MergeMethod, type ReviewRequest, type ReviewRequestDraft, type ReviewRequestStatus } from "./protocol.js";

/** Review Kit's own host commands for the request lifecycle, typed. */
export interface RequestClient {
  status(fresh?: boolean): Promise<ReviewRequestStatus>;
  request(workspace: string): Promise<ReviewRequest | undefined>;
  draft(model?: { provider: string; id: string }, base?: string, writing?: { instructions?: string; template?: boolean }): Promise<ReviewRequestDraft>;
  create(input: { title: string; body: string; base: string; draft: boolean }): Promise<{ status: ReviewRequestStatus; url?: string }>;
  merge(method: MergeMethod): Promise<ReviewRequestStatus>;
  edit(input: { title?: string; body?: string; draft?: boolean }): Promise<ReviewRequestStatus>;
}

export function requestClient(host: HostExtensionClient): RequestClient {
  return {
    status: (fresh) => host.invoke("pr-status", fresh ? { fresh } : undefined) as Promise<ReviewRequestStatus>,
    request: async (workspace) => ((await host.invoke("pr-status", { workspace })) as { request?: ReviewRequest }).request,
    draft: (model, base, writing) => host.invoke("pr-draft", {
      ...(model ? { provider: model.provider, modelId: model.id } : {}),
      ...(base ? { base } : {}),
      ...(writing?.instructions ? { instructions: writing.instructions } : {}),
      ...(writing?.template === false ? { template: false } : {}),
    }) as Promise<ReviewRequestDraft>,
    create: (input) => host.invoke("pr-create", input) as Promise<{ status: ReviewRequestStatus; url?: string }>,
    merge: (method) => host.invoke("pr-merge", { method }) as Promise<ReviewRequestStatus>,
    edit: (input) => host.invoke("pr-edit", input) as Promise<ReviewRequestStatus>,
  };
}

export const requestShort = (request: Pick<ReviewRequest, "provider">): "PR" | "MR" => providerInfo(request.provider).short;

/** "3/4 checks passed", "1 failing", "2 pending" — the shortest honest line. */
export function checksLabel(checks: UiReviewRequestChecks | undefined): string | undefined {
  if (!checks || checks.total === 0) return undefined;
  if (checks.failed > 0) return `${checks.failed} failing`;
  if (checks.pending > 0) return `${checks.pending} pending`;
  return `${checks.passed}/${checks.total} passed`;
}

export function checksTone(checks: UiReviewRequestChecks | undefined): "failed" | "pending" | "passed" | undefined {
  if (!checks || checks.total === 0) return undefined;
  return checks.failed > 0 ? "failed" : checks.pending > 0 ? "pending" : "passed";
}

/** open, draft, merged or closed, as a word for the row and the panel. */
export function requestStateLabel(request: ReviewRequest): string {
  if (request.state === "merged" || request.state === "closed") return request.state;
  return request.draft ? "draft" : "open";
}

const ROW_TTL_MS = 60_000;

/**
 * The request per checkout the rail shows, asked for at most once a minute
 * per path however many rows share it. The Changes section writes what it
 * learned after an action, so its row changes at once.
 */
export class RowRequests {
  private entries = new Map<string, { at: number; request?: ReviewRequest }>();
  private pending = new Set<string>();
  private listeners = new Set<() => void>();

  constructor(private readonly load: (workspace: string) => Promise<ReviewRequest | undefined>, private readonly now: () => number = Date.now) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  get(workspace: string): ReviewRequest | undefined {
    return this.entries.get(workspace)?.request;
  }

  ensure(workspace: string): void {
    const entry = this.entries.get(workspace);
    if (this.pending.has(workspace) || (entry && this.now() - entry.at < ROW_TTL_MS)) return;
    this.pending.add(workspace);
    void this.load(workspace)
      .catch(() => undefined)
      .then((request) => {
        this.pending.delete(workspace);
        this.set(workspace, request);
      });
  }

  set(workspace: string, request: ReviewRequest | undefined): void {
    this.entries.set(workspace, { at: this.now(), ...(request ? { request } : {}) });
    this.listeners.forEach((listener) => listener());
  }
}
