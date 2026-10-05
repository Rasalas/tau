import { useRef, useState } from "react";
import { ChevronDown, GitCommitHorizontal, Info, Sparkles } from "lucide-react";
import { isMacPlatform } from "../keybindings";
import { Menu } from "../deferred-surfaces";
import type { MenuItem } from "./Menu";
import { tooltipProps } from "./ui/Tooltip";

/** A step a kit adds after the commit, offered in the commit button's menu. */
export interface ReviewCommitAction {
  id: string;
  label: string;
  description?: string;
  disabled?: boolean;
  run(): void | Promise<void>;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** What the commit button does, in words: which files, on which branch, and whether it pushes. */
export function commitSummary(files: number, branch: string | undefined, push: boolean, staged = 0): string {
  const left = files - staged;
  const what = staged > 0
    ? `Commits the ${plural(staged, "staged file")}`
    : `Commits all ${plural(files, "changed file")}`;
  const where = branch ? ` on ${branch}` : "";
  const others = staged > 0 && left > 0 ? `; ${left} ${left === 1 ? "other stays" : "others stay"} uncommitted` : "";
  return push ? `${what}${where}${others}, then pushes ${branch ?? "the branch"}.` : `${what}${where}${others}. Nothing is pushed.`;
}

/**
 * The commit, written where the diff is read: one message field and one button.
 * Where a commit can lead (a push, a pull request) sits in the button's menu, so
 * the review never shows two competing ways to commit.
 */
export function ReviewCommitBar({
  message,
  onMessageChange,
  generating,
  note,
  onGenerate,
  busy,
  primaryPush,
  branch,
  fileCount,
  stagedCount,
  actions,
  onCommit,
  onAction,
}: {
  message: string;
  onMessageChange(message: string): void;
  generating: boolean;
  /** Why no message was written, when that went wrong. */
  note?: string | undefined;
  onGenerate?: (() => void) | undefined;
  busy: boolean;
  primaryPush: boolean;
  branch?: string | undefined;
  fileCount: number;
  stagedCount: number;
  actions: readonly ReviewCommitAction[];
  onCommit(message: string, push: boolean): void;
  onAction(action: ReviewCommitAction): void;
}) {
  const [menu, setMenu] = useState(false);
  const anchor = useRef<HTMLSpanElement>(null);
  const empty = message.trim().length === 0;
  const blocked = busy || generating || empty;
  const mac = isMacPlatform();
  const submit = () => { if (!blocked) onCommit(message, primaryPush); };
  const entries: MenuItem[] = [
    ...primaryPush ? [{ id: "push", label: "Commit & push", description: `Then push ${branch ?? "the branch"}` }] : [],
    ...primaryPush ? [{ id: "commit", label: "Commit", description: "Keep it on this computer; nothing is pushed" }] : [],
    ...actions.map((action): MenuItem => ({
      id: `action:${action.id}`,
      label: action.label,
      ...action.description ? { description: action.description } : {},
      ...action.disabled ? { disabled: true } : {},
    })),
  ];
  const select = (id: string) => {
    if (id === "push") onCommit(message, true);
    else if (id === "commit") onCommit(message, false);
    else {
      const action = actions.find((entry) => `action:${entry.id}` === id);
      if (action) onAction(action);
    }
  };

  return <section className="review-commit" aria-label="Commit">
    <span className={`menu-anchor review-commit-split${entries.length > 0 ? " has-menu" : ""}`} ref={anchor}>
      <button className="review-commit-button" title={commitSummary(fileCount, branch, primaryPush, stagedCount)} disabled={blocked} onClick={submit}>
        <GitCommitHorizontal size={14} aria-hidden="true" /> {busy ? "Working…" : primaryPush ? "Commit & push" : "Commit"}
      </button>
      {entries.length > 0 ? <button
        className="review-commit-more"
        aria-label="More ways to commit"
        aria-haspopup="menu"
        aria-expanded={menu}
        disabled={blocked}
        onClick={() => setMenu((open) => !open)}
      ><ChevronDown size={14} aria-hidden="true" /></button> : null}
      {menu ? <Menu align="right" items={entries} label="Commit" onSelect={select} onClose={() => setMenu(false)} /> : null}
    </span>
    <div className="review-commit-field">
      <textarea
        aria-label="Commit message"
        placeholder={generating ? "Writing from the diff…" : `Message (${mac ? "⌘" : "Ctrl+"}Enter to commit)`}
        value={generating ? "" : message}
        disabled={generating}
        onChange={(event) => onMessageChange(event.target.value)}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
            event.preventDefault();
            submit();
          }
        }}
      />
      {onGenerate ? <button
        className="icon-button compact review-commit-write"
        aria-label="Generate commit message"
        {...tooltipProps("Write a new message from the diff", { side: "bottom" })}
        disabled={generating}
        onClick={onGenerate}
      ><Sparkles className={generating ? "spinning" : ""} size={13} /></button> : null}
    </div>
    {note ? <small className="review-commit-note" role="status"><Info size={12} aria-hidden="true" /> {note}</small> : null}
  </section>;
}
