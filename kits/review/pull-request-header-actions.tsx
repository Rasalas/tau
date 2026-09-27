import { useState } from "react";
import { GitMerge, Link2, MoreHorizontal, RotateCcw } from "lucide-react";
import { Menu, READ_ONLY_REASON, errorMessage, tooltipProps, type MenuItem, type MenuSection, type PreferencesStore, type WorkbenchActions } from "tau";
import { providerInfo, type MergeMethod, type PullRequestActionResult, type PullRequestCheck, type PullRequestDetail } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { parseRequestUrl } from "./pull-request-json.js";
import { checksRollup } from "./pull-request-logic.js";
import { openPullRequest } from "./pull-request-open.js";
import { METHOD_LABELS, MergeConfirm, outcomeText, useMergeConfirmation } from "./merge-controls.js";
import { ALL_WRITES, type PullRequestWrites } from "./pull-request-writes.js";

/** A step the view moves into the menu where its header has no room for it, a phone's. */
export type HeaderMenuStep = Pick<MenuItem, "id" | "label" | "icon" | "disabled" | "description"> & { run(): void };

/** Which merge control the header shows in its one slot, after T3 Code's primary control. */
export type PrimaryControl = "merge" | "auto-merge" | "armed" | undefined;

export function primaryControl(detail: Pick<PullRequestDetail, "state" | "draft" | "autoMerge">, checks: readonly PullRequestCheck[], capabilities: { merge: readonly MergeMethod[]; autoMerge: boolean }): PrimaryControl {
  if (detail.state !== "open") return undefined;
  if (detail.autoMerge) return "armed";
  if (detail.draft || capabilities.merge.length === 0) return undefined;
  const rollup = checksRollup(checks);
  // Checks still running or failing: the merge is asked for now and run by the host later.
  if (capabilities.autoMerge && rollup !== undefined && rollup !== "passing") return "auto-merge";
  return "merge";
}

/**
 * The request's own steps in its header: one primary control (merge, arm an
 * auto-merge, or the armed merge's badge) and a menu with the rest — merge
 * now, turn auto-merge on or off, the merge method, link to a thread, revert.
 * Each step the provider cannot take is left out rather than refused; one
 * this device may not take is disabled with the reason.
 */
export function PullRequestHeaderActions({ detail, checks, client, actions, preferences, threadId, onDetail, onPickThread, writes = ALL_WRITES, extra = [] }: {
  detail: PullRequestDetail;
  checks: readonly PullRequestCheck[];
  client: PullRequestClient;
  actions: WorkbenchActions;
  preferences: PreferencesStore;
  threadId: string | undefined;
  onDetail(detail: PullRequestDetail): void;
  onPickThread(): void;
  writes?: PullRequestWrites;
  /** The view's own steps, first in the menu. */
  extra?: readonly HeaderMenuStep[];
}) {
  const info = providerInfo(detail.ref.service);
  const { capabilities } = info;
  const methods = capabilities.merge;
  const confirmation = useMergeConfirmation(methods, preferences);
  const [menu, setMenu] = useState(false);
  const [notice, setNotice] = useState<string>();
  const primary = primaryControl(detail, checks, capabilities);
  const number = detail.ref.number;
  const armed = detail.autoMerge ? `Auto-merge${detail.autoMerge.method ? ` (${METHOD_LABELS[detail.autoMerge.method].toLowerCase()})` : ""}` : undefined;

  const act = (action: "merge" | "auto-merge" | "cancel-auto-merge" | "revert", method?: MergeMethod, deleteBranch?: boolean) => client.action(detail.ref.url, {
    action,
    ...(method ? { method } : {}),
    ...(deleteBranch ? { deleteBranch } : {}),
    ...(threadId ? { threadId } : {}),
  });

  const after = (result: PullRequestActionResult, message: string) => {
    onDetail(result.detail);
    actions.notify(message);
  };

  const confirm = () => confirmation.run(async () => {
    const kind = confirmation.kind;
    if (kind === "merge") {
      const result = await act("merge", confirmation.method, confirmation.deleteBranch);
      after(result, `${info.short} #${number} merged.${outcomeText(result.merge)}`);
    } else if (kind === "auto-merge") {
      after(await act("auto-merge", confirmation.method, confirmation.deleteBranch), `Auto-merge turned on for ${info.short} #${number}: it merges as soon as the host allows, sooner if it already does.`);
    } else if (kind === "revert") {
      const result = await act("revert");
      onDetail(result.detail);
      actions.notify(result.created ? `Opened a ${info.short} that reverts #${number}.` : `Asked ${info.name} to revert #${number}.`);
      const created = result.created ? parseRequestUrl(result.created) : undefined;
      if (created) openPullRequest(actions, { url: created.url, number: created.number, provider: created.service });
    }
  });

  const disarm = async () => {
    setNotice(undefined);
    try { after(await act("cancel-auto-merge"), `Auto-merge turned off for ${info.short} #${number}.`); } catch (error) { setNotice(errorMessage(error)); }
  };

  const open = detail.state === "open";
  const mergeable = open && !detail.draft && methods.length > 0;
  const sections: MenuSection[] = extra.length > 0 ? [{ items: extra.map(({ run: _run, ...item }) => item) }] : [];
  const refused = (allowed: boolean) => allowed ? {} : { disabled: true, description: READ_ONLY_REASON };
  const steps = [
    ...(mergeable && (primary === "auto-merge" || primary === "armed") ? [{ id: "merge-now", label: "Merge now", icon: <GitMerge size={13} /> }] : []),
    ...(open && detail.autoMerge && capabilities.autoMerge ? [{ id: "auto-merge-off", label: "Disable auto-merge", icon: <GitMerge size={13} /> }] : []),
    ...(mergeable && !detail.autoMerge && primary === "merge" && capabilities.autoMerge ? [{ id: "auto-merge-on", label: "Enable auto-merge", icon: <GitMerge size={13} /> }] : []),
  ];
  if (steps.length > 0) sections.push({ items: steps.map((step) => ({ ...step, ...refused(writes.action) })) });
  if (mergeable && methods.length > 1 && writes.action) {
    sections.push({ heading: "Merge method", items: methods.map((method) => ({ id: `method:${method}`, label: METHOD_LABELS[method], selected: confirmation.method === method })) });
  }
  sections.push({ items: [{ id: "link-thread", label: "Link to thread…", icon: <Link2 size={13} />, ...refused(writes.link) }] });
  if (detail.state === "merged" && capabilities.revert) sections.push({ items: [{ id: "revert", label: "Revert changes", icon: <RotateCcw size={13} />, ...refused(writes.action) }] });

  const pick = (id: string) => {
    setMenu(false);
    const step = extra.find((candidate) => candidate.id === id);
    if (step) step.run();
    else if (id === "merge-now") confirmation.open("merge");
    else if (id === "auto-merge-on") confirmation.open("auto-merge");
    else if (id === "auto-merge-off") void disarm();
    else if (id.startsWith("method:")) confirmation.pick(id.slice(7) as MergeMethod);
    else if (id === "link-thread") onPickThread();
    else if (id === "revert") confirmation.open("revert");
  };

  return (
    <>
      {armed && primary === "armed" ? (
        <span className="pr-armed" role="img" aria-label={armed} title={`${armed}: the host merges this on its own once its requirements are met`}>
          <GitMerge size={11} aria-hidden="true" /> {armed}
        </span>
      ) : primary === "auto-merge" && confirmation.method ? (
        <button className="pr-primary" disabled={!writes.action} {...tooltipProps(writes.action ? undefined : READ_ONLY_REASON)} onClick={() => confirmation.open("auto-merge")}>
          <GitMerge size={12} aria-hidden="true" /> Auto-merge ({METHOD_LABELS[confirmation.method].toLowerCase()})
        </button>
      ) : primary === "merge" && confirmation.method ? (
        <button className="pr-primary" disabled={!writes.action} {...tooltipProps(writes.action ? undefined : READ_ONLY_REASON)} onClick={() => confirmation.open("merge")}>
          <GitMerge size={12} aria-hidden="true" /> {METHOD_LABELS[confirmation.method]}
        </button>
      ) : null}
      <span className="menu-anchor">
        <button className="icon-button compact pr-more" aria-label={`More ${info.noun} actions`} title={`More ${info.noun} actions`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <MoreHorizontal size={14} />
        </button>
        {menu ? <Menu align="right" label={`More ${info.noun} actions`} sections={sections} onSelect={pick} onClose={() => setMenu(false)} /> : null}
      </span>
      {notice ? <span className="pr-error pr-head-notice" role="alert" title={notice}>{notice}</span> : null}
      {confirmation.kind ? (
        <MergeConfirm
          kind={confirmation.kind}
          service={detail.ref.service}
          short={info.short}
          number={number}
          base={detail.baseRef}
          {...(detail.headRef ? { branch: detail.headRef } : {})}
          methods={methods}
          {...(confirmation.method ? { method: confirmation.method } : {})}
          onMethod={confirmation.pick}
          deleteBranch={confirmation.deleteBranch}
          onDeleteBranch={confirmation.setDeleteBranch}
          deleteOffered={capabilities.deleteBranch && !(confirmation.kind === "auto-merge" && detail.ref.service === "github")}
          busy={confirmation.busy}
          {...(confirmation.error ? { error: confirmation.error } : {})}
          onConfirm={() => void confirm()}
          onCancel={confirmation.close}
        />
      ) : null}
    </>
  );
}
