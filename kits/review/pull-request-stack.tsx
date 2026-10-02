import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { GitMerge, Layers, RefreshCw } from "lucide-react";
import { Dialog, Menu, READ_ONLY_REASON, errorMessage, type MenuSection, type WorkbenchActions } from "tau";
import { providerInfo, type MergeMethod, type PullRequestDetail, type PullRequestStack, type PullRequestStackLayer, type StackAction } from "./protocol.js";
import { RequestStateIcon } from "./request-state-icon.js";
import type { PullRequestClient } from "./pull-request-client.js";
import { openPullRequest } from "./pull-request-open.js";
import { METHOD_WORDS, layerLine, preferredMethod } from "./merge-controls.js";
import { ALL_WRITES, type PullRequestWrites } from "./pull-request-writes.js";

function LayerGlyph({ layer }: { layer: PullRequestStackLayer }) {
  return <RequestStateIcon state={layerLine(layer).state} />;
}

/** What a stack step may do from this layer: merge it with the layers below, and rebase them all. */
export function stackScope(stack: PullRequestStack, number: number) {
  const position = stack.layers.findIndex((layer) => layer.number === number) + 1;
  const selected = stack.layers[position - 1];
  const below = stack.layers.slice(0, position).filter((layer) => layer.state !== "merged");
  const unmerged = stack.layers.filter((layer) => layer.state !== "merged");
  const mergeBlocked = !selected || selected.state !== "open" || below.length === 0 || below.some((layer) => layer.state !== "open" || layer.draft || !layer.headSha);
  const rebaseBlocked = unmerged.length === 0 || unmerged.some((layer) => layer.state !== "open" || !layer.headSha);
  return { position, below, unmerged, mergeBlocked, rebaseBlocked };
}

/**
 * A request's GitHub stack: "2/8" in the header
 * opens the layers top first (one opens its tab), then "Merge stack", which
 * merges this layer with every unmerged one below it, and "Rebase stack",
 * which updates every branch onto the one below. Both ask first and list
 * what they touch.
 */
export function PullRequestStackControl({ detail, client, actions, workspace, onChanged, writes = ALL_WRITES }: {
  detail: PullRequestDetail;
  client: PullRequestClient;
  actions: WorkbenchActions;
  workspace?: string;
  onChanged(detail: PullRequestDetail): void;
  writes?: PullRequestWrites;
}) {
  const { capabilities } = providerInfo(detail.ref.service);
  const [stack, setStack] = useState<PullRequestStack | null>(null);
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<StackAction>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const load = useCallback(async (fresh: boolean) => {
    try { setStack(await client.stack(detail.ref.url, fresh)); } catch { /* a stack that cannot be read shows nothing */ }
  }, [client, detail.ref.url]);
  // The stack moves with its layers; a new head on this request asks again.
  useEffect(() => { if (capabilities.stacks) void load(false); }, [capabilities.stacks, load, detail.headSha, detail.state]);

  if (!capabilities.stacks || !stack) return null;
  const { position, below, unmerged, mergeBlocked, rebaseBlocked } = stackScope(stack, detail.ref.number);
  if (position === 0) return null;
  const method: MergeMethod | undefined = preferredMethod(capabilities.merge);

  const sections: MenuSection[] = [
    {
      heading: `Stack #${stack.number}`,
      items: [...stack.layers].reverse().map((layer) => {
        const line = layerLine(layer);
        return { id: `layer:${layer.number}`, label: line.title, description: line.detail, icon: <LayerGlyph layer={layer} />, selected: layer.number === detail.ref.number };
      }),
    },
    {
      items: [
        { id: "merge", label: `Merge stack (${below.length})`, icon: <GitMerge size={13} />, disabled: mergeBlocked || !method || !writes.stack, ...(writes.stack ? {} : { description: READ_ONLY_REASON }) },
        { id: "rebase", label: "Rebase stack", icon: <RefreshCw size={13} />, disabled: rebaseBlocked || !writes.stack, ...(writes.stack ? {} : { description: READ_ONLY_REASON }) },
        { id: "refresh", label: "Refresh the stack", icon: <RefreshCw size={13} /> },
      ],
    },
  ];

  const pick = (id: string) => {
    setMenu(false);
    if (id.startsWith("layer:")) {
      const layer = stack.layers.find((entry) => `layer:${entry.number}` === id);
      if (layer && layer.number !== detail.ref.number) openPullRequest(actions, { url: layer.url, number: layer.number, provider: detail.ref.service }, workspace);
    } else if (id === "merge" || id === "rebase") { setError(undefined); setConfirm(id); }
    else if (id === "refresh") void load(true);
  };

  const run = async () => {
    if (!confirm) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await client.stackAction(detail.ref.url, { action: confirm, seen: stack, ...(confirm === "merge" && method ? { method } : {}) });
      onChanged(next);
      actions.notify(confirm === "merge" ? "GitHub merged the stack or added it to its merge queue." : "Stack rebased.");
      setConfirm(undefined);
      void load(true);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const layers = confirm === "merge" ? below : unmerged;
  const label = `Stack #${stack.number}, layer ${position} of ${stack.layers.length}`;
  return (
    <>
      <span className="menu-anchor">
        <button className="pr-stack-button" aria-label={label} title={`View stack #${stack.number}, layer ${position} of ${stack.layers.length}`} aria-expanded={menu} onClick={() => setMenu(!menu)}>
          <Layers size={12} aria-hidden="true" /> {position}/{stack.layers.length}
        </button>
        {menu ? <Menu label={label} sections={sections} footer={<small className="pr-stack-base">↳ {stack.base}</small>} onSelect={pick} onClose={() => setMenu(false)} /> : null}
      </span>
      {confirm ? createPortal(
        <Dialog className="confirm-dialog pr-link-dialog pr-merge-dialog" label={confirm === "merge" ? "Merge the stack" : "Rebase the stack"} onClose={() => { if (!busy) setConfirm(undefined); }}>
          <header>
            <h2>{confirm === "merge" ? `Merge ${layers.length} ${layers.length === 1 ? "pull request" : "pull requests"}?` : `Rebase ${layers.length} ${layers.length === 1 ? "pull request" : "pull requests"}?`}</h2>
            <p>{confirm === "merge"
              ? `Merge #${detail.ref.number} and its unmerged layers below into ${stack.base} using ${method ? METHOD_WORDS[method] : "the repository's default method"}. GitHub checks their rules before merging or queueing them and rebases the rest of the stack afterwards.`
              : `Rebase the remote branches from bottom to top onto ${stack.base}. This rewrites branch history and may restart checks. If a layer fails, the layers before it keep their update.`}</p>
          </header>
          <ul className="pr-stack-confirm">
            {layers.map((layer) => {
              const line = layerLine(layer);
              return <li key={layer.number}><LayerGlyph layer={layer} /><span><strong>{line.title}</strong><small>#{layer.number}</small></span></li>;
            })}
          </ul>
          {error ? <p className="pr-error" role="alert">{error}</p> : null}
          <footer>
            <button disabled={busy} onClick={() => setConfirm(undefined)}>Cancel</button>
            <button className="primary" disabled={busy} onClick={() => void run()}>{busy ? "Working…" : confirm === "merge" ? "Merge stack" : "Rebase stack"}</button>
          </footer>
        </Dialog>,
        document.body,
      ) : null}
    </>
  );
}
