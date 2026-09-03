import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderGit2, GitBranch, History, Plus, Search } from "lucide-react";
import type { UiWorktree, UiWorktreeStatus, WorkspaceInfo } from "../../shared/workspace-kit-types";
import { VirtualList } from "./VirtualList";

type OpenPanel = "workspace" | "refs" | undefined;

function pathName(path: string): string {
  return path.replace(/[\\/]+$/u, "").split(/[\\/]/u).at(-1) ?? path;
}

function fuzzyMatch(value: string, query: string): boolean {
  let at = 0;
  const haystack = value.toLocaleLowerCase();
  for (const character of query.toLocaleLowerCase()) {
    at = haystack.indexOf(character, at);
    if (at < 0) return false;
    at += 1;
  }
  return true;
}

function worktreeStatusLabel(status?: UiWorktreeStatus, loading = false): string {
  if (!status) return loading ? "checking…" : "status unavailable";
  if (status.inspectionError || status.isDirty === undefined) return "status unavailable";
  const parts = [status.isDirty ? "uncommitted changes" : "clean"];
  if (!status.upstream) parts.push("no upstream");
  else {
    if (status.ahead > 0) parts.push(`ahead ${status.ahead}`);
    if (status.behind > 0) parts.push(`behind ${status.behind}`);
  }
  parts.push(status.threadCount === 0 ? "unused" : `${status.threadCount} thread${status.threadCount === 1 ? "" : "s"}`);
  return parts.join(" · ");
}

function WorktreeForm({
  info,
  busy,
  onCreate,
  onCancel,
}: {
  info: WorkspaceInfo;
  busy: boolean;
  onCreate(branch: string, baseRef: string): Promise<boolean>;
  onCancel(): void;
}) {
  const [branch, setBranch] = useState("");
  const [baseRef, setBaseRef] = useState(info.branch || "HEAD");
  const slug = branch.trim().replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");
  const baseRefs = [...new Set([
    info.branch,
    ...info.refs.map((ref) => ref.name),
    info.hasRemote ? "origin/main" : undefined,
  ].filter((ref): ref is string => Boolean(ref)))];

  return (
    <form
      className="worktree-form"
      onSubmit={(event) => { event.preventDefault(); void onCreate(branch.trim(), baseRef); }}
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
      <label>
        <span>START FROM</span>
        <select value={baseRef} onChange={(event) => setBaseRef(event.target.value)} disabled={busy}>
          {baseRefs.map((ref) => <option key={ref} value={ref}>{ref}{ref === info.branch ? " (current)" : ""}</option>)}
        </select>
      </label>
      <small>../{pathName(info.worktreeParent)}/{slug || "…"}</small>
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
  onLoadWorktreeStatuses,
}: {
  info?: WorkspaceInfo;
  busy: boolean;
  onOpenWorktree(path: string): Promise<boolean>;
  onCreateWorktree(branch: string, baseRef: string): Promise<boolean>;
  onSwitchRef(ref: string): Promise<boolean>;
  onLoadWorktreeStatuses(): Promise<UiWorktreeStatus[]>;
}) {
  const [open, setOpen] = useState<OpenPanel>();
  const [creating, setCreating] = useState(false);
  const [query, setQuery] = useState("");
  const [worktreeQuery, setWorktreeQuery] = useState("");
  const [refCursor, setRefCursor] = useState(0);
  const [worktreeCursor, setWorktreeCursor] = useState(0);
  const [worktreeStatuses, setWorktreeStatuses] = useState<UiWorktreeStatus[]>();
  const searchRef = useRef<HTMLInputElement>(null);
  const worktreeSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open !== "refs") return;
    setQuery("");
    setRefCursor(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  useEffect(() => {
    if (open !== "workspace" || creating) return;
    let current = true;
    setWorktreeQuery("");
    setWorktreeCursor(0);
    setWorktreeStatuses(undefined);
    requestAnimationFrame(() => worktreeSearchRef.current?.focus());
    void onLoadWorktreeStatuses().then(
      (statuses) => { if (current) setWorktreeStatuses(statuses); },
      () => { if (current) setWorktreeStatuses([]); },
    );
    return () => { current = false; };
  }, [creating, onLoadWorktreeStatuses, open]);

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
  const label = !info?.isRepo ? "Local folder" : current?.isMain ? "Current checkout" : current?.name ?? "Worktree";

  const worktreeNeedle = worktreeQuery.trim();
  const worktrees = useMemo(
    () => (info?.worktrees ?? []).filter((tree) => !worktreeNeedle || fuzzyMatch(`${tree.branch ?? ""} ${tree.name} ${tree.path}`, worktreeNeedle)),
    [info?.worktrees, worktreeNeedle],
  );
  const statusesByPath = useMemo(() => new Map(worktreeStatuses?.map((status) => [status.path, status]) ?? []), [worktreeStatuses]);
  useEffect(() => setWorktreeCursor(0), [worktreeNeedle]);

  const needle = query.trim().toLowerCase();
  const refs = useMemo(
    () => (info?.refs ?? []).filter((ref) => !needle || ref.name.toLowerCase().includes(needle)),
    [info?.refs, needle],
  );

  useEffect(() => setRefCursor(0), [needle]);
  const close = () => { setOpen(undefined); setCreating(false); };
  const chooseRef = (refName: string) => {
    if (refs.find((ref) => ref.name === refName)?.isCurrent) { close(); return; }
    void onSwitchRef(refName).then((changed) => { if (changed) close(); });
  };
  const chooseWorktree = (tree: UiWorktree) => {
    if (tree.isCurrent) { close(); return; }
    void onOpenWorktree(tree.path).then((changed) => { if (changed) close(); });
  };

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
                onCreate={async (branch, baseRef) => {
                  const created = await onCreateWorktree(branch, baseRef);
                  if (created) close();
                  return created;
                }}
                onCancel={() => setCreating(false)}
              />
            ) : (
              <>
                <div className="worktree-search">
                  <Search size={13} />
                  <input
                    ref={worktreeSearchRef}
                    type="search"
                    value={worktreeQuery}
                    onChange={(event) => setWorktreeQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowDown") { event.preventDefault(); setWorktreeCursor((value) => worktrees.length ? (value + 1) % worktrees.length : 0); }
                      if (event.key === "ArrowUp") { event.preventDefault(); setWorktreeCursor((value) => worktrees.length ? (value - 1 + worktrees.length) % worktrees.length : 0); }
                      if (event.key === "Enter" && worktrees[worktreeCursor]) { event.preventDefault(); chooseWorktree(worktrees[worktreeCursor]); }
                    }}
                    placeholder="Search worktrees…"
                    aria-label="Search worktrees"
                  />
                </div>
                <button className="new-worktree" onClick={() => setCreating(true)} disabled={!info?.isRepo}>
                  <Plus size={13} />
                  <span>New worktree…</span>
                </button>
                <VirtualList
                  items={worktrees}
                  itemHeight={49}
                  className="worktree-list"
                  empty={<p>No worktree matches “{worktreeQuery}”.</p>}
                  scrollToIndex={worktreeCursor}
                  role="listbox"
                  ariaLabel="Worktrees"
                  renderItem={(tree, index) => {
                    const status = statusesByPath.get(tree.path);
                    return <button
                      key={tree.path}
                      className={tree.isCurrent || index === worktreeCursor ? "selected" : ""}
                      onClick={() => chooseWorktree(tree)}
                      role="option"
                      aria-selected={tree.isCurrent}
                    >
                      {tree.isMain ? <Folder size={13} /> : tree.isCurrent ? <FolderGit2 size={13} /> : <History size={13} />}
                      <span className="menu-label">
                        <em>{tree.isMain ? "Current checkout" : tree.branch ?? tree.name}</em>
                        <small>{worktreeStatusLabel(status, worktreeStatuses === undefined)}</small>
                      </span>
                      {status?.cleanupCandidate ? <small className="cleanup-candidate">cleanup candidate</small> : null}
                    </button>;
                  }}
                />
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
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") { event.preventDefault(); setRefCursor((value) => refs.length ? (value + 1) % refs.length : 0); }
                  if (event.key === "ArrowUp") { event.preventDefault(); setRefCursor((value) => refs.length ? (value - 1 + refs.length) % refs.length : 0); }
                  if (event.key === "Enter" && refs[refCursor]) { event.preventDefault(); chooseRef(refs[refCursor].name); }
                }}
                placeholder="Search refs…"
                aria-label="Search refs"
              />
            </div>
            <VirtualList
              items={refs}
              itemHeight={32}
              className="ref-list"
              empty={<p>No ref matches “{query}”.</p>}
              scrollToIndex={refCursor}
              renderItem={(ref, index) => <button
                key={ref.name}
                className={ref.isCurrent || index === refCursor ? "selected" : ""}
                onClick={() => chooseRef(ref.name)}
              >
                <span>{ref.name}</span>{ref.isCurrent ? <small>current</small> : ref.worktreePath ? <small>worktree</small> : null}
              </button>}
            />
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
