import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Menu, type MenuSection } from "./Menu";

export function ThreadTitleMenu({
  title,
  label,
  pinned,
  settled,
  onNewThread,
  onOpenTree,
  onOpenInstructions,
  onDuplicate,
  onTogglePin,
  onToggleSettled,
  onRename,
  commands = [],
  onCommand,
  onMarkUnread,
  onCopy,
  canCopyPath = true,
}: {
  title: string;
  /** Short label of the project, e.g. its Git branch. */
  label?: string;
  pinned: boolean;
  settled: boolean;
  onNewThread(): void;
  /** Pi's /tree and /clone for this thread. */
  onOpenTree(): void;
  /** Inspect active system prompt and AGENTS.md instructions. */
  onOpenInstructions?(): void;
  onDuplicate(): void;
  onTogglePin(): void;
  onToggleSettled(): void;
  onRename(title: string): Promise<boolean>;
  /** Extension commands offered on the thread-title surface. */
  commands?: ReadonlyArray<{ id: string; label: string }>;
  onCommand?(id: string): void;
  onMarkUnread(): void;
  onCopy(value: "chat" | "path" | "thread-id"): void;
  /** A path of a host that is not this machine is not worth copying. */
  canCopyPath?: boolean;
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
        { id: "new", label: label ? `New thread on ${label}` : "New thread" },
        { id: "tree", label: "Thread tree…" },
        ...(onOpenInstructions ? [{ id: "instructions", label: "Active instructions & prompt…" }] : []),
        { id: "duplicate", label: "Duplicate thread" },
        { id: "pin", label: pinned ? "Unpin thread" : "Pin thread" },
        { id: "settle", label: settled ? "Un-settle thread" : "Settle thread" },
      ],
    },
    {
      items: [
        { id: "rename", label: "Rename thread" },
        ...commands.map((command) => ({ id: `command:${command.id}`, label: command.label })),
        { id: "unread", label: "Mark unread" },
      ],
    },
    {
      items: [
        { id: "copy-chat", label: "Copy entire chat as Markdown" },
        ...(canCopyPath ? [{ id: "copy-path", label: "Copy path" }] : []),
        { id: "copy-thread-id", label: "Copy thread ID" },
      ],
    },
  ];

  const select = (id: string) => {
    if (id === "new") onNewThread();
    if (id === "tree") onOpenTree();
    if (id === "instructions") onOpenInstructions?.();
    if (id === "duplicate") onDuplicate();
    if (id === "pin") onTogglePin();
    if (id === "settle") onToggleSettled();
    if (id === "rename") setRenaming(true);
    if (id.startsWith("command:")) onCommand?.(id.slice("command:".length));
    if (id === "unread") onMarkUnread();
    if (id === "copy-chat") onCopy("chat");
    if (id === "copy-path") onCopy("path");
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
