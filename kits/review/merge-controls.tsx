import { useState } from "react";
import { createPortal } from "react-dom";
import { Dialog, MiddleTruncate, getClientStorage, tooltipProps, type PreferencesStore } from "tau";
import { REVIEW_HOST_EXTENSION_ID, type MergeMethod, type MergeOutcome, type PullRequestStackLayer, type RequestService } from "./protocol.js";

/** Labels for the three methods. */
export const METHOD_LABELS: Record<MergeMethod, string> = { merge: "Merge", squash: "Squash and merge", rebase: "Rebase and merge" };
export const METHOD_WORDS: Record<MergeMethod, string> = { merge: "a merge commit", squash: "squash", rebase: "rebase" };

/** Review Kit's option: a merge deletes the request's branch unless the confirmation says otherwise. */
export const DELETE_BRANCH_OPTION = "delete-branch-on-merge";
const METHOD_KEY = "tau.review.merge-method";

export function deleteBranchByDefault(preferences: PreferencesStore): boolean {
  return preferences.optionValue(REVIEW_HOST_EXTENSION_ID, DELETE_BRANCH_OPTION, false) === true;
}

/** The method the user merged with last, where the host offers it, else the host's first. */
export function preferredMethod(methods: readonly MergeMethod[]): MergeMethod | undefined {
  const last = getClientStorage()?.get(METHOD_KEY);
  return methods.find((method) => method === last) ?? methods[0];
}

export function rememberMethod(method: MergeMethod): void {
  getClientStorage()?.set(METHOD_KEY, method);
}

/** What became of the branch, as the end of a notice. */
export function outcomeText(outcome: MergeOutcome | undefined): string {
  if (outcome?.branchDeleted) return ` Deleted ${outcome.branchDeleted}.`;
  if (outcome?.branchKept) return ` The branch stays: ${outcome.branchKept.replace(/\.$/u, "")}.`;
  return "";
}

export type MergeConfirmKind = "merge" | "auto-merge" | "revert";

/**
 * The question before a merge, an armed merge or a revert:
 * what happens in one sentence, the method where there is a choice, and
 * whether the branch goes too. Nothing reaches the host before the button.
 */
export function MergeConfirm({ kind, service, short, number, base, branch, methods, method, onMethod, deleteBranch, onDeleteBranch, deleteOffered, busy, error, onConfirm, onCancel }: {
  kind: MergeConfirmKind;
  service: RequestService;
  short: string;
  number: number;
  base?: string;
  branch?: string;
  methods: readonly MergeMethod[];
  method?: MergeMethod;
  onMethod(method: MergeMethod): void;
  deleteBranch: boolean;
  onDeleteBranch(value: boolean): void;
  /** Whether the host deletes the branch for this step. */
  deleteOffered: boolean;
  busy: boolean;
  error?: string;
  onConfirm(): void;
  onCancel(): void;
}) {
  const title = kind === "merge" ? `Merge ${short} #${number}?` : kind === "auto-merge" ? "Enable auto-merge?" : "Revert these changes?";
  const how = method ? METHOD_WORDS[method] : "";
  const description = kind === "merge"
    ? `This merges #${number}${base ? ` into ${base}` : ""} using ${how}.`
    : kind === "auto-merge"
      ? `This merges #${number} using ${how} as soon as the host considers it ready, which may be immediately.`
      : `This opens a new ${short === "MR" ? "merge request" : "pull request"} that reverses the changes merged by #${number}.`;
  const confirm = kind === "merge" ? (method ? METHOD_LABELS[method] : "Merge") : kind === "auto-merge" ? "Enable auto-merge" : `Create revert ${short}`;
  return createPortal(
    <Dialog className="confirm-dialog pr-link-dialog pr-merge-dialog" label={title} onClose={() => { if (!busy) onCancel(); }}>
      <header>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {kind !== "revert" && methods.length > 1 ? (
        <div className="toggle-group" role="radiogroup" aria-label="Merge method">
          {methods.map((entry) => (
            <button key={entry} role="radio" aria-checked={method === entry} className={method === entry ? "active" : ""} disabled={busy} onClick={() => onMethod(entry)}>{METHOD_LABELS[entry]}</button>
          ))}
        </div>
      ) : null}
      {kind !== "revert" && branch ? (
        deleteOffered ? (
          <label className="pr-merge-option">
            <input type="checkbox" aria-label={`Delete ${branch} ${kind === "auto-merge" ? "once it merged" : "after merging"}`} checked={deleteBranch} disabled={busy} onChange={(event) => onDeleteBranch(event.target.checked)} />
            <span>
              {kind === "auto-merge" ? "Delete the branch once it merged" : "Delete the branch after merging"}
              <BranchName branch={branch} />
            </span>
          </label>
        ) : kind === "auto-merge" && service === "github" ? (
          <p className="pr-merge-note">
            GitHub deletes the branch after an automatic merge when the repository is set to delete merged branches.
            <BranchName branch={branch} />
          </p>
        ) : null
      ) : null}
      {error ? <p className="pr-error" role="alert">{error}</p> : null}
      <footer>
        <button disabled={busy} onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy || (kind !== "revert" && !method)} onClick={onConfirm}>{busy ? "Working…" : confirm}</button>
      </footer>
    </Dialog>,
    document.body,
  );
}

/** A branch on a line of its own, cut in the middle; the full name is its tooltip. */
function BranchName({ branch }: { branch: string }) {
  return <MiddleTruncate className="pr-merge-branch" value={branch} {...tooltipProps(branch, { variant: "code" })} />;
}

/** One layer as a stack's list and its confirmation name it. */
export function layerLine(layer: PullRequestStackLayer): { title: string; detail: string; state: "open" | "draft" | "merged" | "closed" } {
  const state = layer.state === "open" && layer.draft ? "draft" : layer.state;
  return { title: layer.title ?? layer.headRef, detail: `#${layer.number} · ${layer.headRef}`, state };
}

/** Local state of one confirmation: which question is open, the method and the branch choice. */
export function useMergeConfirmation(methods: readonly MergeMethod[], preferences: PreferencesStore) {
  const [kind, setKind] = useState<MergeConfirmKind>();
  const [method, setMethod] = useState<MergeMethod | undefined>(() => preferredMethod(methods));
  const [deleteBranch, setDeleteBranch] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const chosen = method && methods.includes(method) ? method : preferredMethod(methods);
  return {
    kind, method: chosen, deleteBranch, busy, error,
    open(next: MergeConfirmKind) { setKind(next); setError(undefined); setDeleteBranch(deleteBranchByDefault(preferences)); },
    close() { setKind(undefined); setError(undefined); },
    pick(next: MergeMethod) { setMethod(next); rememberMethod(next); },
    setDeleteBranch,
    async run(step: () => Promise<void>) {
      setBusy(true);
      setError(undefined);
      try { await step(); setKind(undefined); } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); } finally { setBusy(false); }
    },
  };
}
