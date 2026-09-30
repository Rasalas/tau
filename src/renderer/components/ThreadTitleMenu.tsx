import { useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MenuSection } from "./Menu";
import { Menu } from "../deferred-surfaces";
import { commandRefusal, READ_ONLY_REASON } from "../use-host-capabilities";

/** A menu as the title opens it: what it shows and what a pick does. */
export interface ThreadTitleMenuModel {
  sections: MenuSection[];
  run(id: string): void;
}

/** The title's own menu, for a window without a thread menu (Thread Rail's). */
export function coreThreadMenu({
  label,
  pinned,
  settled,
  readOnly,
  commands,
  canCopyPath,
  run,
}: {
  /** Short label of the project, e.g. its Git branch. */
  label?: string | undefined;
  pinned: boolean;
  settled: boolean;
  readOnly: boolean;
  /** Extension commands offered on the thread-title surface. */
  commands: ReadonlyArray<{ id: string; label: string; destructive?: boolean; access?: "read" | "write"; unavailable?(): string | undefined }>;
  /** A path of a host that is not this machine is not worth copying. */
  canCopyPath: boolean;
  /** Ids: new, tree, instructions, duplicate, pin, settle, unread, copy-chat, copy-path, copy-thread-id, command:<id>. */
  run(id: string): void;
}): ThreadTitleMenuModel {
  // Copying, marking and looking stay this device's; the host refuses the rest (ADR 0024).
  const locked = readOnly ? { disabled: true, description: READ_ONLY_REASON } : {};
  const item = (command: (typeof commands)[number]) => {
    const reason = commandRefusal(command, readOnly);
    return { id: `command:${command.id}`, label: command.label, ...(command.destructive ? { destructive: true } : {}), ...(reason ? { disabled: true, description: reason } : {}) };
  };
  const destructive = commands.filter((command) => command.destructive).map(item);
  return {
    sections: [
      {
        items: [
          { id: "new", label: label ? `New thread on ${label}` : "New thread", ...locked },
          { id: "tree", label: "Thread tree…" },
          { id: "instructions", label: "Active instructions & prompt…" },
          { id: "duplicate", label: "Duplicate thread", ...locked },
          { id: "pin", label: pinned ? "Unpin thread" : "Pin thread", ...locked },
          { id: "settle", label: settled ? "Un-settle thread" : "Settle thread", ...locked },
        ],
      },
      { items: [{ id: "rename", label: "Rename thread", ...locked }, ...commands.filter((command) => !command.destructive).map(item), { id: "unread", label: "Mark unread" }] },
      {
        items: [
          { id: "copy-chat", label: "Copy entire chat as Markdown" },
          ...(canCopyPath ? [{ id: "copy-path", label: "Copy path" }] : []),
          { id: "copy-thread-id", label: "Copy thread ID" },
        ],
      },
      ...(destructive.length ? [{ items: destructive }] : []),
    ],
    run,
  };
}

/** The thread's title, opening its menu; `rename` in any menu edits the title in place. */
export function ThreadTitleMenu({ title, menu, onRename }: {
  title: string;
  /** Read when the menu opens. */
  menu(): ThreadTitleMenuModel;
  onRename(title: string): Promise<boolean>;
}) {
  const [open, setOpen] = useState<ThreadTitleMenuModel>();
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
        aria-expanded={Boolean(open)}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => (current ? undefined : menu()))}
      >
        <span>{title}</span>
        <ChevronDown size={16} />
      </button>
      {open ? (
        <Menu
          align="left"
          sections={open.sections}
          onSelect={(id) => (id === "rename" ? setRenaming(true) : open.run(id))}
          onClose={() => setOpen(undefined)}
        />
      ) : null}
    </span>
  );
}
