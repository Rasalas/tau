import { homedir } from "node:os";
import { HostCommandError, type HostExtensionContext } from "tau/host-extension";
import type { PullRequestCheck, PullRequestDetail, PullRequestFiles, PullRequestRef, PullRequestThread, PullRequestViewedState } from "./protocol.js";
import { pullRequestCalls, type CliCall } from "./pull-request-cli.js";
import {
  diffFingerprint,
  parseGitHubChecks,
  parseGitHubDetail,
  parseGitHubThreads,
  parseGitLabChecks,
  parseGitLabDetail,
  parseGitLabDiffs,
  parseGitLabThreads,
  parseRequestUrl,
  parseUnifiedDiff,
} from "./pull-request-json.js";
import { LocalViewedStore } from "./pull-request-viewed.js";
import { defaultCliRunner, explainCliFailure, SERVICES, type CliRunner } from "./request-cli.js";

/** A read is reused this long, for a tab reopened or a second client; `fresh` skips it. */
const READ_TTL_MS = 60_000;
const DIFF_BUFFER = 16 * 1024 * 1024;

const record = (input: unknown): Record<string, unknown> => input && typeof input === "object" ? input as Record<string, unknown> : {};
const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;

export interface PullRequestCommandOptions {
  run?: CliRunner;
  now?(): number;
}

/**
 * The pull-request view's host half: one request, addressed by its URL, read
 * and written through `gh` or `glab`. Reads are cached per request for a
 * minute and every write drops that request's cache, so the view's next read
 * shows what the write did.
 */
export function registerPullRequestCommands(context: HostExtensionContext, options: PullRequestCommandOptions = {}): void {
  const { services } = context;
  const run = options.run ?? defaultCliRunner;
  const now = options.now ?? Date.now;
  const cache = new Map<string, { at: number; value: Promise<unknown> }>();
  const viewedStore = new LocalViewedStore(services.stateDir, now);

  const target = (input: unknown): PullRequestRef => {
    const url = text(record(input).url);
    const ref = url ? parseRequestUrl(url) : undefined;
    if (!ref) throw new HostCommandError("Name a pull or merge request by its URL.");
    return ref;
  };

  const cli = async (ref: PullRequestRef, call: CliCall, action: string, maxBuffer?: number): Promise<string> => {
    const facts = SERVICES[ref.service];
    const command = services.findCommand(facts.tool);
    if (!command) throw new HostCommandError(`${facts.label} is not installed or not on your PATH. Install it from ${facts.install}, then run \`${facts.login}\`.`);
    services.noteSubprocess();
    try {
      // The URL names the repository, so no checkout is needed to run in.
      return await run(command, call.args, homedir(), { ...(call.input !== undefined ? { input: call.input } : {}), ...(maxBuffer ? { maxBuffer } : {}) });
    } catch (error) {
      throw new HostCommandError(explainCliFailure(ref.service, action, error));
    }
  };

  const cached = <T>(kind: string, ref: PullRequestRef, fresh: boolean, read: () => Promise<T>): Promise<T> => {
    const key = `${kind}\0${ref.url}`;
    const entry = cache.get(key);
    if (entry && !fresh && now() - entry.at < READ_TTL_MS) return entry.value as Promise<T>;
    const value = read();
    cache.set(key, { at: now(), value });
    value.catch(() => { if (cache.get(key)?.value === value) cache.delete(key); });
    return value;
  };

  const forget = (ref: PullRequestRef) => {
    for (const key of cache.keys()) if (key.endsWith(`\0${ref.url}`)) cache.delete(key);
  };

  const noun = (ref: PullRequestRef) => `${SERVICES[ref.service].short} #${ref.number}`;

  const detail = (ref: PullRequestRef, fresh: boolean) => cached("view", ref, fresh, async (): Promise<PullRequestDetail> => {
    const calls = pullRequestCalls.view(ref);
    const outputs = await Promise.all(calls.map((call) => cli(ref, call, `Reading ${noun(ref)}`)));
    return ref.service === "github" ? parseGitHubDetail(ref, outputs[0]!) : parseGitLabDetail(ref, outputs[0]!, outputs[1]!, outputs[2]!);
  });

  const githubThreads = (ref: PullRequestRef, fresh: boolean) => cached("threads", ref, fresh, async () =>
    parseGitHubThreads(await cli(ref, pullRequestCalls.threads(ref), `Reading the conversations of ${noun(ref)}`)));

  const threads = (ref: PullRequestRef, fresh: boolean): Promise<PullRequestThread[]> => ref.service === "github"
    ? githubThreads(ref, fresh).then((read) => read.threads)
    : cached("threads", ref, fresh, async () => parseGitLabThreads(await cli(ref, pullRequestCalls.threads(ref), `Reading the conversations of ${noun(ref)}`)));

  const changes = (ref: PullRequestRef, fresh: boolean) => cached("diff", ref, fresh, async () => {
    const output = await cli(ref, pullRequestCalls.diff(ref), `Reading the diff of ${noun(ref)}`, DIFF_BUFFER);
    return ref.service === "github" ? parseUnifiedDiff(output) : parseGitLabDiffs(output);
  });

  const files = async (ref: PullRequestRef, fresh: boolean): Promise<PullRequestFiles> => {
    const entries = await changes(ref, fresh);
    let states: Map<string, PullRequestViewedState>;
    if (ref.service === "github") {
      states = (await githubThreads(ref, fresh)).viewed;
    } else {
      states = await viewedStore.states(ref.url, new Map(entries.map((entry) => [entry.file.path, diffFingerprint(entry.diff)])));
    }
    return {
      files: entries.map((entry) => ({ ...entry.file, viewed: states.get(entry.file.path) ?? "unviewed" })),
      diffs: entries.map((entry) => entry.diff),
      viewedOn: ref.service === "github" ? "host" : "local",
    };
  };

  const fresh = (input: unknown) => record(input).fresh === true;

  context.registerCommand("pr-view", (input) => detail(target(input), fresh(input)), { long: true });

  context.registerCommand("pr-checks", async (input): Promise<PullRequestCheck[]> => {
    const ref = target(input);
    // Checks move on their own, so they are never served from the cache.
    const output = await cli(ref, pullRequestCalls.checks(ref), `Reading the checks of ${noun(ref)}`);
    const raw = record(JSON.parse(output));
    return ref.service === "github" ? parseGitHubChecks(raw.statusCheckRollup) : parseGitLabChecks(raw.head_pipeline ?? raw.pipeline);
  });

  context.registerCommand("pr-comments", (input) => threads(target(input), fresh(input)), { long: true });

  context.registerCommand("pr-files", (input) => files(target(input), fresh(input)), { long: true });

  context.registerCommand("pr-comment", async (input) => {
    const ref = target(input);
    const fields = record(input);
    const body = text(fields.body)?.trim();
    if (!body) throw new HostCommandError("Write a comment first.");
    const threadId = text(fields.threadId);
    const path = text(fields.path);
    const line = typeof fields.line === "number" && Number.isInteger(fields.line) && fields.line > 0 ? fields.line : undefined;
    let call: CliCall;
    if (threadId) {
      call = pullRequestCalls.reply(ref, threadId, body);
    } else if (path && line !== undefined) {
      const known = await detail(ref, false);
      call = pullRequestCalls.lineComment(ref, {
        path, line, body,
        side: fields.side === "old" ? "old" : "new",
        ...(known.headSha ? { headSha: known.headSha } : {}),
        ...(known.diffRefs ? { diffRefs: known.diffRefs } : {}),
      });
    } else {
      call = pullRequestCalls.comment(ref, body);
    }
    await cli(ref, call, `Commenting on ${noun(ref)}`);
    forget(ref);
    services.log("request.commented", `${noun(ref)}${threadId ? " · reply" : path ? ` · ${path}:${line}` : ""}`);
    return { ok: true };
  }, { long: true });

  context.registerCommand("pr-update", async (input): Promise<PullRequestDetail> => {
    const ref = target(input);
    const fields = record(input);
    const title = text(fields.title)?.trim();
    const body = text(fields.body);
    if (text(fields.title) !== undefined && !title) throw new HostCommandError("A title is required.");
    if (title === undefined && body === undefined) throw new HostCommandError("Nothing to change.");
    await cli(ref, pullRequestCalls.edit(ref, { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) }), `Editing ${noun(ref)}`);
    forget(ref);
    services.log("request.edited", noun(ref));
    return detail(ref, true);
  }, { long: true });

  context.registerCommand("pr-viewed", async (input): Promise<{ viewed: PullRequestViewedState }> => {
    const ref = target(input);
    const fields = record(input);
    const path = text(fields.path);
    if (!path) throw new HostCommandError("Name the file to mark.");
    const viewed = fields.viewed === true;
    if (ref.service === "github") {
      const nodeId = (await githubThreads(ref, false)).nodeId ?? (await detail(ref, false)).nodeId;
      if (!nodeId) throw new HostCommandError(`GitHub did not name ${noun(ref)}'s id; refresh and try again.`);
      await cli(ref, pullRequestCalls.viewed(ref, nodeId, path, viewed), `Marking ${path} ${viewed ? "viewed" : "not viewed"}`);
      cache.delete(`threads\0${ref.url}`);
    } else {
      const entry = (await changes(ref, false)).find((candidate) => candidate.file.path === path);
      if (!entry) throw new HostCommandError(`${path} is not part of ${noun(ref)}.`);
      await viewedStore.set(ref.url, path, diffFingerprint(entry.diff), viewed);
    }
    return { viewed: viewed ? "viewed" : "unviewed" };
  }, { long: true });
}
