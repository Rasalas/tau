import { useEffect } from "react";
import { READ_ONLY_REASON, type PreferencesStore } from "tau";
import { MergeConfirm, outcomeText, useMergeConfirmation } from "./merge-controls.js";
import { providerInfo, type PullRequestListEntry } from "./protocol.js";
import type { PullRequestClient } from "./pull-request-client.js";

const NO_PREFERENCES = { optionValue: (_extension: string, _option: string, fallback: unknown) => fallback } as unknown as PreferencesStore;

/**
 * Merge from an inbox row: the request view's question (method, delete the
 * branch), then the host's merge. The repository's usual method is picked.
 */
export function PullMergeDialog({ entry, client, preferences, allowed, onDone, onClose }: {
  entry: PullRequestListEntry;
  client: PullRequestClient;
  preferences: PreferencesStore | undefined;
  allowed: boolean;
  onDone(message: string): void;
  onClose(): void;
}) {
  const info = providerInfo(entry.ref.service);
  const methods = info.capabilities.merge;
  const confirmation = useMergeConfirmation(methods, preferences ?? NO_PREFERENCES);
  // Opened with the dialog; it closes with the row's state.
  useEffect(() => { confirmation.open("merge"); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!confirmation.kind) return null;
  const confirm = () => confirmation.run(async () => {
    const result = await client.action(entry.ref.url, { action: "merge", ...(confirmation.method ? { method: confirmation.method } : {}), ...(confirmation.deleteBranch ? { deleteBranch: true } : {}) });
    onDone(`${info.short} ${info.sign}${entry.ref.number} merged.${outcomeText(result.merge)}`);
  });
  return (
    <MergeConfirm
      kind="merge"
      service={entry.ref.service}
      short={info.short}
      number={entry.ref.number}
      base={entry.baseRef}
      branch={entry.headRef}
      methods={methods}
      {...(confirmation.method ? { method: confirmation.method } : {})}
      onMethod={confirmation.pick}
      deleteBranch={confirmation.deleteBranch}
      onDeleteBranch={confirmation.setDeleteBranch}
      deleteOffered={info.capabilities.deleteBranch}
      busy={confirmation.busy}
      {...(confirmation.error ? { error: confirmation.error } : {})}
      {...(allowed ? {} : { disabledReason: READ_ONLY_REASON })}
      onConfirm={() => void confirm()}
      onCancel={onClose}
    />
  );
}
