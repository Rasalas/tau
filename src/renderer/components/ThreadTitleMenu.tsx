import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Menu, type MenuSection } from "./Menu";

export function ThreadTitleMenu({
  title,
  branch,
  pinned,
  settled,
  onNewThread,
  onTogglePin,
  onToggleSettled,
  onRename,
  onRegenerate,
  onMarkUnread,
  onCopy,
}: {
  title: string;
  branch?: string;
  pinned: boolean;
  settled: boolean;
  onNewThread(): void;
  onTogglePin(): void;
  onToggleSettled(): void;
  onRename(title: string): Promise<boolean>;
  onRegenerate(): void;
  onMarkUnread(): void;
  onCopy(value: "path" | "branch" | "thread-id"): void;
}) {
  const [open, setOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!renaming) setDraft(title);
  }, [renaming, title]);

  useEffect(() => {
    if (!renaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [renaming]);

  const sections: MenuSection[] = [
    {
      items: [
        { id: "new", label: branch ? `New thread on ${branch}` : "New thread" },
        { id: "pin", label: pinned ? "Unpin thread" : "Pin thread" },
        { id: "settle", label: settled ? "Un-settle thread" : "Settle thread" },
      ],
    },
    {
      items: [
        { id: "rename", label: "Rename thread" },
        { id: "regenerate", label: "Regenerate title" },
        { id: "unread", label: "Mark unread" },
      ],
    },
    {
      items: [
        { id: "copy-path", label: "Copy path" },
        ...(branch ? [{ id: "copy-branch", label: "Copy branch" }] : []),
        { id: "copy-thread-id", label: "Copy thread ID" },
      ],
    },
  ];

  const select = (id: string) => {
    if (id === "new") onNewThread();
    if (id === "pin") onTogglePin();
    if (id === "settle") onToggleSettled();
    if (id === "rename") setRenaming(true);
    if (id === "regenerate") onRegenerate();
    if (id === "unread") onMarkUnread();
    if (id === "copy-path") onCopy("path");
    if (id === "copy-branch") onCopy("branch");
    if (id === "copy-thread-id") onCopy("thread-id");
  };

  if (renaming) {
    return (
      <form
        className="thread-title-rename"
        onSubmit={(event) => {
          event.preventDefault();
          const next = draft.trim();
          if (!next || saving) return;
          setSaving(true);
          void onRename(next).then((saved) => {
            setSaving(false);
            if (saved) setRenaming(false);
          });
        }}
      >
        <input
          ref={inputRef}
          aria-label="Thread title"
          maxLength={120}
          value={draft}
          disabled={saving}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            setDraft(title);
            setRenaming(false);
          }}
        />
      </form>
    );
  }

  return (
    <span className="menu-anchor thread-title-control">
      <button
        className="thread-title-trigger"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{title}</span>
        <ChevronDown size={16} />
      </button>
      {open ? (
        <Menu
          align="left"
          sections={sections}
          onSelect={select}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </span>
  );
}
