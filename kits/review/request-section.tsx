import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ExternalLink, GitPullRequest, GitPullRequestDraft, Link2, RefreshCw, X } from "lucide-react";
import { errorMessage, type DesktopExtensionContext, type WorkbenchActions } from "tau";
import type { LinkDialogs } from "./link-dialog.js";
import type { PullRequestClient } from "./pull-request-client.js";
import type { ThreadLinkRows } from "./thread-links-store.js";
import { commitMessageModel, followRequestTemplate, writingInstructions } from "./commit-messages.js";
import { providerInfo, type ChangesSectionProps, type MergeMethod, type ReviewRequest, type ReviewRequestStatus, type WorkspaceStoreApi } from "./protocol.js";
import { checksLabel, checksTone, requestShort, requestStateLabel, type RequestClient, type RowRequests } from "./requests.js";
import { openPullRequest } from "./pull-request-tab.js";
import { openLocalPullRequest } from "./local-request-tab.js";
import { PublishForm } from "./publish-form.js";
import { deleteBranchByDefault, outcomeText, preferredMethod, rememberMethod } from "./merge-controls.js";

type Mode = "idle" | "create" | "merge" | "edit" | "publish";

interface Form {
  title: string;
  body: string;
  base: string;
  draft: boolean;
}

const EMPTY_FORM: Form = { title: "", body: "", base: "", draft: false };

const METHODS: Array<{ value: MergeMethod; label: string }> = [
  { value: "squash", label: "Squash" },
  { value: "merge", label: "Merge commit" },
  { value: "rebase", label: "Rebase" },
];

/**
 * Review Kit's part of the Changes panel: where the branch's pull or merge
 * request stands, and the steps after a commit — create (with a generated
 * title and body), edit, merge. Each step shows its form or question first;
 * nothing reaches the hosting service before the user confirms it there.
 */
export function createRequestSection(plugin: DesktopExtensionContext, store: WorkspaceStoreApi, client: RequestClient, rows: RowRequests, links: LinkedParts) {
  return function RequestSection({ actions, message, committed }: ChangesSectionProps) {
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const cwd = snapshot.cwd;
    const branch = snapshot.workspace?.branch;
    const [status, setStatus] = useState<ReviewRequestStatus>();
    const [mode, setMode] = useState<Mode>("idle");
    const [form, setForm] = useState<Form>(EMPTY_FORM);
    const [method, setMethod] = useState<MergeMethod>(() => preferredMethod(["squash", "merge", "rebase"]) ?? "squash");
    const [deleteBranch, setDeleteBranch] = useState(false);
    const [busy, setBusy] = useState<string>();
    const [error, setError] = useState<string>();
    const latest = useRef(0);

    const publish = useCallback((next: ReviewRequestStatus) => {
      setStatus(next);
      if (cwd) rows.set(cwd, next.request);
    }, [cwd]);

    const refresh = useCallback(async (fresh = false) => {
      const request = ++latest.current;
      try {
        const next = await client.status(fresh);
        if (request === latest.current) { publish(next); setError(undefined); }
      } catch (reason) {
        if (request === latest.current) setError(errorMessage(reason));
      }
    }, [publish]);

    useEffect(() => { setMode("idle"); void refresh(); }, [cwd, branch, refresh]);

    const run = async (label: string, step: () => Promise<void>) => {
      setBusy(label);
      setError(undefined);
      try { await step(); } catch (reason) { setError(errorMessage(reason)); } finally { setBusy(undefined); }
    };

    const request = status?.request;
    const open = request && (request.state === undefined || request.state === "open") ? request : undefined;
    const { short, capabilities } = providerInfo(status?.service ?? "github");
    const methods = METHODS.filter((entry) => capabilities.merge.includes(entry.value));
    // A provider without the chosen method merges by its first one.
    const chosen = methods.some((entry) => entry.value === method) ? method : methods[0]?.value ?? method;
    const hasChanges = snapshot.changes.files.length > 0;
    // Checks still running or failing: the host can merge it later, once they pass.
    const waiting = Boolean(open && !open.autoMerge && capabilities.autoMerge && open.checks && (open.checks.pending > 0 || open.checks.failed > 0));

    const startCreate = () => run("Writing title and description…", async () => {
      if (hasChanges) {
        if (!message.trim()) throw new Error("Write a commit message first.");
        if (!await store.commit(message, false)) return;
        committed();
      }
      setForm({ ...EMPTY_FORM, base: status?.base ?? "" });
      setMode("create");
      await generate();
    });

    const generate = async () => {
      const model = commitMessageModel(actions.activeThread()?.model, plugin.preferences);
      const draft = await client.draft(model, form.base || status?.base, { instructions: writingInstructions(plugin.preferences), template: followRequestTemplate(plugin.preferences) });
      setForm((current) => ({ ...current, title: draft.title, body: draft.body, base: current.base || draft.base }));
    };

    const create = () => run(`Creating ${short}…`, async () => {
      const result = await client.create(form);
      publish(result.status);
      setMode("idle");
      void store.refresh();
      const created = result.status.request;
      actions.notify(created ? `${requestShort(created)} #${created.number} created${form.draft ? " as draft" : ""}.` : `${short} created.`);
    });

    const merge = () => run(`Merging ${short}…`, async () => {
      rememberMethod(chosen);
      const next = await client.merge(chosen, deleteBranch && capabilities.deleteBranch);
      publish(next);
      setMode("idle");
      void store.refresh();
      actions.notify(`${short} #${open?.number ?? ""} merged.${outcomeText(next.merge)}`);
    });

    const autoMerge = (enable: boolean) => run(enable ? "Turning on auto-merge…" : "Turning off auto-merge…", async () => {
      if (enable) rememberMethod(chosen);
      const next = await client.autoMerge(enable, enable ? chosen : undefined, enable && deleteBranch && capabilities.deleteBranch);
      publish(next);
      setMode("idle");
      actions.notify(enable ? `Auto-merge turned on for ${short} #${open?.number ?? ""}: it merges as soon as the host allows.` : `Auto-merge turned off for ${short} #${open?.number ?? ""}.`);
    });

    const save = () => run(`Saving ${short}…`, async () => {
      if (!open) return;
      const next = await client.edit({
        ...(form.title !== open.title ? { title: form.title } : {}),
        ...(form.body !== (open.body ?? "") ? { body: form.body } : {}),
        ...(form.draft !== Boolean(open.draft) ? { draft: form.draft } : {}),
      });
      publish(next);
      setMode("idle");
      actions.notify(`${short} #${open.number} updated.`);
    });

    const field = (key: keyof Form) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

    return (
      <div className="request-section" aria-label="Pull request">
        <div className="request-line">
          <GitPullRequest size={13} aria-hidden="true" />
          {request ? <RequestSummary request={request} onOpen={() => openPullRequest(actions, request, cwd)} onBrowse={() => actions.openExternal(request.url)} /> : (
            <small className="request-none">{status ? (branch ? `No ${short} for ${branch}` : `No ${short}`) : "Checking…"}</small>
          )}
          <span className="spacer" />
          {branch ? (
            <button className="icon-button compact" title="Review the branch as a pull request, with its pictures, before anything is pushed" aria-label="Open the local pull request" onClick={() => openLocalPullRequest(actions)}>
              <GitPullRequestDraft size={12} />
            </button>
          ) : null}
          <button className="icon-button compact" title="Refresh request status" aria-label="Refresh request status" disabled={Boolean(busy)} onClick={() => void refresh(true)}>
            <RefreshCw size={12} />
          </button>
        </div>
        {status?.problem ? <p className="request-problem" role="note">{status.problem}</p> : null}
        {error ? <p className="request-error" role="alert">{error}</p> : null}
        {busy ? <p className="request-busy">{busy}</p> : null}

        {mode === "idle" && status && !status.problem && !busy ? (
          <div className="commit-actions request-actions">
            {!open ? (
              capabilities.create ? (
                <button className="primary" disabled={hasChanges && !message.trim()} onClick={() => void startCreate()}>
                  {hasChanges ? `Commit & create ${short}…` : `Create ${short}…`}
                </button>
              ) : null
            ) : (
              <>
                {capabilities.edit || capabilities.draft ? <button onClick={() => { setForm({ title: open.title, body: open.body ?? "", base: open.baseRef, draft: Boolean(open.draft) }); setMode("edit"); }}>Edit…</button> : null}
                {open.autoMerge && capabilities.autoMerge ? <button onClick={() => void autoMerge(false)}>Disable auto-merge</button> : null}
                {methods.length > 0 ? <button className="primary" onClick={() => { setDeleteBranch(deleteBranchByDefault(plugin.preferences)); setMode("merge"); }}>Merge…</button> : null}
              </>
            )}
          </div>
        ) : null}

        {mode === "idle" && status && !status.remote && status.branch && !busy ? (
          <div className="commit-actions request-actions">
            <button className="primary" onClick={() => setMode("publish")}>Publish repository…</button>
          </div>
        ) : null}
        {mode === "publish" ? (
          <PublishForm
            host={plugin.host}
            onCancel={() => setMode("idle")}
            onPublished={(result) => {
              setMode("idle");
              actions.notify(result.pushed ? `Published ${result.repository} and pushed ${result.branch}.` : `Created ${result.repository} and added it as origin.`);
              void store.refresh();
              void refresh(true);
            }}
          />
        ) : null}

        {mode === "create" || mode === "edit" ? (
          <div className="request-form">
            {mode === "create" || capabilities.edit ? <>
              <input aria-label={`${short} title`} placeholder="Title" value={form.title} onChange={field("title")} />
              <textarea aria-label={`${short} description`} placeholder="Description" value={form.body} onChange={field("body")} />
            </> : null}
            {mode === "create" ? (
              <label className="request-base">into <input aria-label="Base branch" value={form.base} onChange={field("base")} /></label>
            ) : null}
            {capabilities.draft ? (
              <label className="request-draft">
                <input type="checkbox" checked={form.draft} onChange={(event) => setForm((current) => ({ ...current, draft: event.target.checked }))} /> Draft
              </label>
            ) : null}
            <div className="commit-actions">
              {mode === "create" ? (
                <button className="primary" disabled={Boolean(busy) || !form.title.trim()} onClick={() => void create()}>
                  {form.draft ? `Create draft ${short}` : `Create ${short}`}
                </button>
              ) : (
                <button className="primary" disabled={Boolean(busy) || !form.title.trim()} onClick={() => void save()}>Save</button>
              )}
              {mode === "create" ? <button disabled={Boolean(busy)} onClick={() => void run("Writing title and description…", generate)}>Regenerate</button> : null}
              <button disabled={Boolean(busy)} onClick={() => { setMode("idle"); setError(undefined); }}>Cancel</button>
            </div>
          </div>
        ) : null}

        {mode === "merge" && open ? (
          <div className="request-form" role="group" aria-label={`Merge ${short} #${open.number}`}>
            <div className="toggle-group" role="radiogroup" aria-label="Merge method">
              {methods.map((entry) => (
                <button key={entry.value} role="radio" aria-checked={chosen === entry.value} className={chosen === entry.value ? "active" : ""} onClick={() => setMethod(entry.value)}>{entry.label}</button>
              ))}
            </div>
            <p className="request-confirm">
              Merge {short} #{open.number} into <code>{open.baseRef}</code> ({METHODS.find((entry) => entry.value === chosen)?.label.toLowerCase()})?
              {open.draft ? " It is still a draft." : ""}
              {open.checks && open.checks.failed > 0 ? ` ${open.checks.failed} check${open.checks.failed === 1 ? " is" : "s are"} failing.` : ""}
              {waiting ? " Auto-merge lets the host merge it once its checks and approvals pass." : ""}
            </p>
            {capabilities.deleteBranch && open.headRef ? (
              <label className="request-draft">
                <input type="checkbox" checked={deleteBranch} onChange={(event) => setDeleteBranch(event.target.checked)} /> Delete <code>{open.headRef}</code> after merging
              </label>
            ) : null}
            <div className="commit-actions">
              {waiting ? <button className="primary" disabled={Boolean(busy)} onClick={() => void autoMerge(true)}>Enable auto-merge</button> : null}
              <button className={waiting ? "" : "primary"} disabled={Boolean(busy)} onClick={() => void merge()}>{waiting ? "Merge now" : `Merge ${short} #${open.number}`}</button>
              <button disabled={Boolean(busy)} onClick={() => setMode("idle")}>Cancel</button>
            </div>
          </div>
        ) : null}

        <LinkedRequests actions={actions} parts={links} />
      </div>
    );
  };
}

function RequestSummary({ request, onOpen, onBrowse }: { request: ReviewRequest; onOpen(): void; onBrowse(): void }) {
  const armed = request.state === "open" && request.autoMerge ? `auto-merge${request.autoMerge.method ? ` · ${request.autoMerge.method}` : ""}` : undefined;
  const state = requestStateLabel(request);
  const checks = checksLabel(request.checks);
  const short = requestShort(request);
  return (
    <>
      <button className="request-link" title={`${request.title} · opens the ${short} view`} onClick={onOpen}>
        {short} #{request.number}
      </button>
      <button className="icon-button compact" aria-label={`Open ${short} #${request.number} in the browser`} title="Open in the browser" onClick={onBrowse}>
        <ExternalLink size={10} />
      </button>
      <span className={`request-state state-${state}`}>{state}</span>
      {checks ? <span className={`request-checks ${checksTone(request.checks)}`}>checks {checks}</span> : null}
      {armed ? <span className="request-state state-armed" title="The host merges it on its own once its requirements are met">{armed}</span> : null}
    </>
  );
}

/** What the linked-requests list needs: the window's copy of the links, the host commands and the dialog. */
export interface LinkedParts {
  rows: ThreadLinkRows;
  client: PullRequestClient;
  dialogs: LinkDialogs;
}

/**
 * The requests the thread on screen links, whichever repository they live
 * in: open one as its tab, unlink it, or link another.
 */
function LinkedRequests({ actions, parts }: { actions: WorkbenchActions; parts: LinkedParts }) {
  const thread = actions.activeThread();
  const threadId = thread?.sessionId;
  const links = useSyncExternalStore(parts.rows.subscribe, () => parts.rows.get(threadId));
  const [error, setError] = useState<string>();
  useEffect(() => { if (threadId) void parts.rows.load(threadId, true); }, [parts.rows, threadId]);
  if (!threadId) return null;
  const unlink = async (url: string) => {
    setError(undefined);
    try { await parts.client.unlink(threadId, url); await parts.rows.load(threadId); } catch (reason) { setError(errorMessage(reason)); }
  };
  return (
    <div className="request-links" aria-label="Linked pull requests">
      <div className="request-line">
        <Link2 size={13} aria-hidden="true" />
        <small className="request-none">{links.length === 0 ? "No linked pull requests" : `Linked (${links.length})`}</small>
        <span className="spacer" />
        <button className="icon-button compact" aria-label="Link pull request" title="Link pull request…" onClick={() => parts.dialogs.show({ threadId, ...(thread?.cwd ? { cwd: thread.cwd } : {}) })}>
          <GitPullRequest size={12} />
        </button>
      </div>
      {links.map((link) => {
        const short = providerInfo(link.service).short;
        const state = link.state === "open" && link.draft ? "draft" : link.state ?? "open";
        return (
          <div key={link.url} className="request-link-row">
            <button className="request-link" title={`${link.title ?? link.url} · opens the ${short} view`} onClick={() => openPullRequest(actions, { url: link.url, number: link.number, provider: link.service }, thread?.cwd)}>
              {short} #{link.number}
            </button>
            <span className="request-link-title" title={`${link.repo}${link.title ? ` · ${link.title}` : ""}`}>{link.title ?? link.repo}</span>
            <span className={`request-state state-${state}`}>{state}</span>
            <button className="icon-button compact" aria-label={`Unlink ${short} #${link.number}`} title="Unlink" onClick={() => void unlink(link.url)}>
              <X size={11} />
            </button>
          </div>
        );
      })}
      {error ? <p className="request-error" role="alert">{error}</p> : null}
    </div>
  );
}
