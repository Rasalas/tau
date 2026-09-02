import { useEffect, useState } from "react";
import { GitFork, MessageSquare, Sparkles, User } from "lucide-react";
import type { UiThreadTree, UiThreadTreeNode } from "../../shared/contracts";

export type ThreadTreeMode = "navigate" | "fork";

/**
 * Pi's /tree and /fork in one list: the session tree flattened in preorder,
 * the current branch marked. Navigate moves the thread to an entry in the same
 * session file; fork starts a new thread through a user message.
 */
export function ThreadTreeModal({
  tree,
  mode,
  busy = false,
  error,
  onClose,
  onNavigate,
  onFork,
}: {
  tree?: UiThreadTree;
  mode: ThreadTreeMode;
  busy?: boolean;
  error?: string;
  onClose(): void;
  onNavigate(entryId: string, summarize: boolean): void;
  onFork(entryId: string): void;
}) {
  const [summarize, setSummarize] = useState(false);
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);

  const selectable = (node: UiThreadTreeNode) => mode === "fork" ? node.forkable : !node.isLeaf;
  const choose = (node: UiThreadTreeNode) => {
    if (busy || !selectable(node)) return;
    if (mode === "fork") onFork(node.id);
    else onNavigate(node.id, summarize);
  };
  const nodes = tree?.nodes ?? [];

  return (
    <>
      <button className="project-modal-scrim" aria-label="Close thread tree" onClick={onClose} />
      <section className="project-modal thread-tree" role="dialog" aria-modal="true" aria-label={mode === "fork" ? "Fork thread" : "Thread tree"}>
        <header className="project-modal-title">
          <span>
            <strong>{mode === "fork" ? "Fork thread" : "Thread tree"}</strong>
            <small>{mode === "fork"
              ? "Pick the message the new thread continues from."
              : "Pick where this thread continues from; later messages leave the context but stay in the file."}</small>
          </span>
          <button className="modal-close" onClick={onClose}>esc</button>
        </header>
        {error ? <p className="thread-tree-error">{error}</p> : null}
        <ol className="thread-tree-list">
          {nodes.map((node) => (
            <li key={node.id} style={{ paddingLeft: `${12 + node.depth * 16}px` }}>
              <button
                type="button"
                className={`thread-tree-node${node.onBranch ? " on-branch" : ""}${node.isLeaf ? " leaf" : ""}`}
                disabled={busy || !selectable(node)}
                title={node.isLeaf ? "The thread is here" : node.kind}
                onClick={() => choose(node)}
              >
                <i>{node.kind === "user" ? <User size={12} /> : node.kind === "assistant" ? <MessageSquare size={12} /> : <Sparkles size={12} />}</i>
                <span>
                  {node.label ? <b className="thread-tree-label">{node.label}</b> : null}
                  {node.text}
                </span>
                {node.isLeaf ? <small>here</small> : mode === "fork" && node.forkable ? <small><GitFork size={11} /> fork</small> : null}
              </button>
            </li>
          ))}
          {tree && nodes.length === 0 ? <li className="thread-tree-empty">This thread has no messages yet.</li> : null}
          {!tree && !error ? <li className="thread-tree-empty">Loading the tree…</li> : null}
        </ol>
        <footer className="project-modal-help">
          {mode === "navigate" ? (
            <label className="thread-tree-summarize">
              <input type="checkbox" checked={summarize} onChange={(event) => setSummarize(event.target.checked)} />
              Summarize the abandoned branch into the context
            </label>
          ) : null}
          <span className="spacer" />
          <span><kbd>Esc</kbd> Close</span>
        </footer>
      </section>
    </>
  );
}
