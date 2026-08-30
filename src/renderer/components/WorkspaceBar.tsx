import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderGit2, GitBranch, History, Plus, Search } from "lucide-react";
import type { WorkspaceInfo } from "../../shared/contracts";

type OpenPanel = "workspace" | "refs" | undefined;

function WorktreeForm({
  info,
  busy,
  onCreate,
  onCancel,
}: {
  info: WorkspaceInfo;
  busy: boolean;
  onCreate(branch: string): void;
  onCancel(): void;
}) {
  const [branch, setBranch] = useState("");
  const slug = branch.trim().replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");

  return (
    <form
      className="worktree-form"
      onSubmit={(event) => { event.preventDefault(); onCreate(branch.trim()); }}
    >
      <label>
        <span>NEW WORKTREE</span>
        <input
          autoFocus
          value={branch}
          onChange={(event) => setBranch(event.target.value)}
          placeholder="feat/my-branch"
          disabled={busy}
        />
      </label>
      <small>{info.worktreeParent}/{slug || "…"}</small>
      <div className="worktree-form-actions">
        <button type="button" onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="submit" className="primary" disabled={busy || !branch.trim()}>
          {busy ? "Creating…" : "Create"}
        </button>
      </div>
    </form>
  );
}

export function WorkspaceBar({
  info,
  busy,
  onOpenWorktree,
  onCreateWorktree,
  onSwitchRef,
}: {
  info?: WorkspaceInfo;
  busy: boolean;
  onOpenWorktree(path: string): void;
  onCreateWorktree(branch: string): void;
  onSwitchRef(ref: string): void;
}) {
  const [open, setOpen] = useState<OpenPanel>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open !== "refs") return;
    setQuery("");
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(undefined);
      setCreating(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open]);

  const current = info?.worktrees.find((tree) => tree.isCurrent);
  const others = info?.worktrees.filter((tree) => !tree.isCurrent) ?? [];
  const label = !info?.isRepo ? "Local folder" : current?.isMain ? "Current checkout" : current?.name ?? "Worktree";

  const needle = query.trim().toLowerCase();
  const refs = useMemo(
    () => (info?.refs ?? []).filter((ref) => !needle || ref.name.toLowerCase().includes(needle)),
    [info?.refs, needle],
  );

  const close = () => { setOpen(undefined); setCreating(false); };

  return (
    <div className="workspace-bar">
      {open ? <button className="menu-scrim" aria-label="Close" onClick={close} /> : null}

      <div className="menu-anchor">
        <button
          className="workspace-chip"
          disabled={busy}
          onClick={() => setOpen(open === "workspace" ? undefined : "workspace")}
        >
          <Folder size={13} />
          <span>{label}</span>
          <ChevronDown size={12} className="chev" />
        </button>

        {open === "workspace" ? (
          <div className="menu above workspace-menu">
            {creating && info ? (
              <WorktreeForm
                info={info}
                busy={busy}
                onCreate={(branch) => { onCreateWorktree(branch); close(); }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <>
                <div className="menu-heading">WORKSPACE</div>
                {info?.worktrees.filter((tree) => tree.isMain).map((tree) => (
                  <button
                    key={tree.path}
                    className={tree.isCurrent ? "selected" : ""}
                    onClick={() => { if (!tree.isCurrent) onOpenWorktree(tree.path); close(); }}
                  >
                    <Folder size={13} />
                    <span>Current checkout</span>
                  </button>
                ))}
                <button onClick={() => setCreating(true)} disabled={!info?.isRepo}>
                  <Plus size={13} />
                  <span>New worktree…</span>
                </button>
                {others.filter((tree) => !tree.isMain).map((tree) => (
                  <button key={tree.path} onClick={() => { onOpenWorktree(tree.path); close(); }}>
                    <History size={13} />
                    <span>Worktree ({tree.branch ?? tree.name})</span>
                  </button>
                ))}
                {current && !current.isMain ? (
                  <button className="selected" onClick={close}>
                    <FolderGit2 size={13} />
                    <span>{current.branch ?? current.name}</span>
                  </button>
                ) : null}
              </>
            )}
          </div>
        ) : null}
      </div>

      <span className="workspace-bar-spacer" />

      <div className="menu-anchor">
        <button
          className="workspace-chip"
          disabled={busy || !info?.isRepo}
          onClick={() => setOpen(open === "refs" ? undefined : "refs")}
        >
          <GitBranch size={13} />
          <span>{info?.branch ?? "no branch"}</span>
          <ChevronDown size={12} className="chev" />
        </button>

        {open === "refs" ? (
          <div className="menu above right ref-picker">
            <div className="ref-search">
              <Search size={13} />
              <input
                ref={searchRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search refs…"
                aria-label="Search refs"
              />
            </div>
            <div className="ref-list">
              {refs.map((ref) => (
                <button
                  key={ref.name}
                  className={ref.isCurrent ? "selected" : ""}
                  onClick={() => { if (!ref.isCurrent) onSwitchRef(ref.name); close(); }}
                >
                  <span>{ref.name}</span>
                  {ref.isCurrent ? <small>current</small> : ref.worktreePath ? <small>worktree</small> : null}
                </button>
              ))}
              {refs.length === 0 ? <p>No ref matches “{query}”.</p> : null}
            </div>
            {info?.isDirty ? (
              <div className="ref-note">
                Uncommitted changes — a ref without a worktree cannot be checked out in place.
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </div>
  );
}
