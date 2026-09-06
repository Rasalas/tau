import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Folder, FolderGit2, GitBranch, History, Plus, Search, Sparkles, Trash2 } from "lucide-react";
import { VirtualList, type UiWorktree, type UiWorktreeStatus, type WorkspaceInfo } from "tau";
import type { UiWorktreeBase, UiWorktreeRemoval, WorkspaceMode } from "./protocol.js";

type OpenPanel = "workspace" | "refs" | undefined;

/** Rows of the worktree picker: the typed name as a new worktree, then the existing ones. */
type PickerItem = { kind: "create"; branch: string } | { kind: "worktree"; tree: UiWorktree };

const worktreeSlug = (branch: string) => branch.trim().replace(/[^a-z0-9._-]+/giu, "-").replace(/^-+|-+$/gu, "");

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

export function WorkspaceBar({
  info,
  busy,
  mode,
  base,
  onOpenWorktree,
  onCreateWorktree,
  onSwitchRef,
  onLoadWorktreeStatuses,
  onSuggestName,
  onModeChange,
  onRemoveWorktree,
  onPreviewRemoval,
}: {
  info?: WorkspaceInfo;
  busy: boolean;
  /** Set while a draft may still choose where its thread runs; absent once it has one. */
  mode?: WorkspaceMode;
  /** Where a new worktree would start; undefined until the picker asked. */
  base?: UiWorktreeBase;
  onOpenWorktree(path: string): Promise<boolean>;
  onCreateWorktree(branch: string, baseRef: string): Promise<boolean>;
  onSwitchRef(ref: string): Promise<boolean>;
  onLoadWorktreeStatuses(): Promise<UiWorktreeStatus[]>;
  /** Present while an extension can name a worktree from the task; resolves undefined when it could not. */
  onSuggestName?(hint: string): Promise<string | undefined>;
  onModeChange?(mode: WorkspaceMode): void;
  onRemoveWorktree?(tree: UiWorktree): Promise<boolean>;
  onPreviewRemoval?(tree: UiWorktree): Promise<UiWorktreeRemoval>;
}) {
  const [open, setOpen] = useState<OpenPanel>();
  const [naming, setNaming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const [query, setQuery] = useState("");
  const [worktreeQuery, setWorktreeQuery] = useState("");
  const [refCursor, setRefCursor] = useState(0);
  const [worktreeCursor, setWorktreeCursor] = useState(0);
  const [worktreeStatuses, setWorktreeStatuses] = useState<UiWorktreeStatus[]>();
  const [removing, setRemoving] = useState<{ tree: UiWorktree; preview?: UiWorktreeRemoval }>();
  const searchRef = useRef<HTMLInputElement>(null);
  const worktreeSearchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open !== "refs") return;
    setQuery("");
    setRefCursor(0);
    requestAnimationFrame(() => searchRef.current?.focus());
  }, [open]);

  // Reset and load once per opening; the loader prop changes identity on every parent render and must not retrigger this.
  const loadStatusesRef = useRef(onLoadWorktreeStatuses);
  loadStatusesRef.current = onLoadWorktreeStatuses;
  useEffect(() => {
    if (open !== "workspace") return;
    let current = true;
    setWorktreeQuery("");
    setWorktreeCursor(0);
    setWorktreeStatuses(undefined);
    setRemoving(undefined);
    requestAnimationFrame(() => worktreeSearchRef.current?.focus());
    void loadStatusesRef.current().then(
      (statuses) => { if (current) setWorktreeStatuses(statuses); },
      () => { if (current) setWorktreeStatuses([]); },
    );
    return () => { current = false; };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(undefined);
    };
    // The scrim sits in the bar's stacking context, so overlays above it still get the click; watch the document too.
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current && event.target instanceof Node && !rootRef.current.contains(event.target)) setOpen(undefined);
    };
    window.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open]);

  const current = info?.worktrees.find((tree) => tree.isCurrent);
  const label = !info?.isRepo ? "Local folder" : current?.isMain ? "Current checkout" : current?.name ?? "Worktree";

  const worktreeNeedle = worktreeQuery.trim();
  // The host resolved the base (origin/HEAD, fetched); until it answers, the
  // current branch is the honest thing to show.
  const baseRef = base?.ref ?? info?.branch ?? "HEAD";
  const baseLabel = base ? `${base.ref} @ ${base.shortCommit}` : baseRef;
  const pickerItems = useMemo<PickerItem[]>(() => {
    const trees = info?.worktrees ?? [];
    const items: PickerItem[] = trees
      .filter((tree) => !worktreeNeedle || fuzzyMatch(`${tree.branch ?? ""} ${tree.name}`, worktreeNeedle))
      .map((tree) => ({ kind: "worktree", tree }));
    // A name no worktree carries is offered as a new one, first so it stays in view above a long list.
    const exact = trees.some((tree) => tree.branch === worktreeNeedle || tree.name === worktreeNeedle);
    if (worktreeNeedle && info?.isRepo && !exact) items.unshift({ kind: "create", branch: worktreeNeedle });
    return items;
  }, [info?.hasRemote, info?.isRepo, info?.worktrees, worktreeNeedle]);
  const statusesByPath = useMemo(() => new Map(worktreeStatuses?.map((status) => [status.path, status]) ?? []), [worktreeStatuses]);
  // Enter still opens the best match while one exists; ArrowUp reaches the new-worktree row.
  const createAboveMatches = pickerItems.length > 1 && pickerItems[0]?.kind === "create";
  useEffect(() => setWorktreeCursor(createAboveMatches ? 1 : 0), [createAboveMatches, worktreeNeedle]);

  const needle = query.trim().toLowerCase();
  const refs = useMemo(
    () => (info?.refs ?? []).filter((ref) => !needle || ref.name.toLowerCase().includes(needle)),
    [info?.refs, needle],
  );

  useEffect(() => setRefCursor(0), [needle]);
  const close = () => setOpen(undefined);
  const chooseRef = (refName: string) => {
    if (refs.find((ref) => ref.name === refName)?.isCurrent) { close(); return; }
    void onSwitchRef(refName).then((changed) => { if (changed) close(); });
  };
  const chooseWorktree = (tree: UiWorktree) => {
    if (tree.isCurrent) { close(); return; }
    void onOpenWorktree(tree.path).then((changed) => { if (changed) close(); });
  };
  const createWorktree = (branch: string, from: string) => onCreateWorktree(branch, from).then((created) => { if (created) close(); return created; });
  const choosePickerItem = (item: PickerItem) => {
    if (item.kind === "worktree") chooseWorktree(item.tree);
    else void createWorktree(item.branch, baseRef);
  };
  // The suggestion lands in the search so it can be read and edited; Enter on its row creates it.
  const nameWorktree = async () => {
    if (!onSuggestName) return;
    setNaming(true);
    try {
      const branch = await onSuggestName(worktreeNeedle);
      if (branch) { setWorktreeQuery(branch); requestAnimationFrame(() => { setWorktreeCursor(0); worktreeSearchRef.current?.focus(); }); }
    } finally {
      setNaming(false);
    }
  };

  return (
    <div className="workspace-bar" ref={rootRef}>
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
            <>
              {mode && onModeChange ? (
                <div className="workspace-mode segmented" role="group" aria-label="Where this thread runs">
                  <button
                    className={mode === "current" ? "primary" : ""}
                    aria-pressed={mode === "current"}
                    onClick={() => onModeChange("current")}
                  >Current checkout</button>
                  <button
                    className={mode === "worktree" ? "primary" : ""}
                    aria-pressed={mode === "worktree"}
                    disabled={!info?.isRepo}
                    onClick={() => onModeChange("worktree")}
                  >New worktree</button>
                  <small>{mode === "worktree" ? `created from ${baseLabel} when you send` : "the checkout this project is on"}</small>
                </div>
              ) : null}
              <div className="worktree-search">
                <Search size={13} />
                <input
                  ref={worktreeSearchRef}
                  type="search"
                  value={worktreeQuery}
                  onChange={(event) => setWorktreeQuery(event.target.value)}
                  onKeyDown={(event) => {
                    const count = pickerItems.length;
                    if (event.key === "ArrowDown") { event.preventDefault(); setWorktreeCursor((value) => count ? (value + 1) % count : 0); }
                    if (event.key === "ArrowUp") { event.preventDefault(); setWorktreeCursor((value) => count ? (value - 1 + count) % count : 0); }
                    if (event.key === "Enter" && pickerItems[worktreeCursor]) { event.preventDefault(); choosePickerItem(pickerItems[worktreeCursor]); }
                  }}
                  placeholder="Search worktrees or type a new name…"
                  aria-label="Search worktrees"
                />
              </div>
              {onSuggestName ? (
                <button className="new-worktree" onClick={() => void nameWorktree()} disabled={!info?.isRepo || naming}>
                  <Sparkles size={13} />
                  <span>New worktree</span>
                  <small>{naming ? "naming…" : "automatic naming"}</small>
                </button>
              ) : null}
              <VirtualList
                items={pickerItems}
                itemHeight={49}
                className="worktree-list"
                empty={<p>No worktree matches “{worktreeQuery}”.</p>}
                scrollToIndex={worktreeCursor}
                role="listbox"
                ariaLabel="Worktrees"
                renderItem={(item, index) => {
                  if (item.kind === "create") {
                    return <button
                      key="create"
                      className={index === worktreeCursor ? "selected" : ""}
                      onClick={() => void createWorktree(item.branch, baseRef)}
                      role="option"
                      aria-selected={false}
                    >
                      <Plus size={13} />
                      <span className="menu-label">
                        <em>Create worktree “{item.branch}”</em>
                        <small>with exactly this name · from {baseLabel} · ../{pathName(info?.worktreeParent ?? "")}/{worktreeSlug(item.branch) || "…"}</small>
                      </span>
                    </button>;
                  }
                  const { tree } = item;
                  const status = statusesByPath.get(tree.path);
                  if (removing?.tree.path === tree.path) {
                    const preview = removing.preview;
                    return <div className="worktree-remove" key={tree.path}>
                      <span className="menu-label">
                        <em>Remove {tree.branch ?? tree.name}?</em>
                        <small>
                          {preview
                            ? `${preview.dirtyFiles} uncommitted file${preview.dirtyFiles === 1 ? "" : "s"} · ${preview.ahead} commit${preview.ahead === 1 ? "" : "s"} beyond its base`
                            : "reading what it holds…"}
                        </small>
                      </span>
                      <button className="danger" onClick={() => {
                        setRemoving(undefined);
                        void onRemoveWorktree?.(tree);
                      }}>Remove</button>
                      <button onClick={() => setRemoving(undefined)}>Cancel</button>
                    </div>;
                  }
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
                    {!tree.isMain && !tree.isCurrent && onRemoveWorktree ? (
                      <span
                        className="worktree-remove-action"
                        role="button"
                        tabIndex={-1}
                        aria-label={`Remove ${tree.branch ?? tree.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          setRemoving({ tree });
                          void onPreviewRemoval?.(tree)
                            .then((preview) => setRemoving((shown) => shown?.tree.path === tree.path ? { tree, preview } : shown))
                            .catch(() => undefined);
                        }}
                      ><Trash2 size={12} /></span>
                    ) : null}
                  </button>;
                }}
              />
            </>
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
