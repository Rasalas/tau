import { Bot, MessageSquare, X } from "lucide-react";
import type { ReactNode } from "react";
import type { StageTab } from "../stage";
import { useThreadShell } from "../use-thread-shell";
import { FileKindIcon } from "./FileKindIcon";

function fileName(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

export interface ChatTab {
  active: boolean;
  streaming: boolean;
  onSelect(active: boolean): void;
}

/** What every tab of the strip does, whatever it holds. */
interface TabChrome {
  active: boolean;
  preview: boolean;
  activate(): void;
  close(): void;
  pin(): void;
}

function StageTabButton({ chrome, title, label, icon, marker }: {
  chrome: TabChrome;
  title: string;
  label: string;
  icon: ReactNode;
  marker?: ReactNode;
}) {
  return <div
    role="tab"
    tabIndex={0}
    aria-selected={chrome.active}
    title={title}
    className={`stage-tab ${chrome.active ? "active" : ""} ${chrome.preview ? "preview" : ""}`}
    onClick={chrome.activate}
    onDoubleClick={chrome.pin}
    onAuxClick={(event) => { if (event.button === 1) chrome.close(); }}
    onKeyDown={(event) => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chrome.activate(); }
    }}
  >
    <span className="stage-tab-icon">{icon}</span>
    <span className="stage-tab-label">{label}</span>
    {marker}
    <button
      className="stage-tab-close"
      aria-label={`Close ${label}`}
      tabIndex={-1}
      onClick={(event) => { event.stopPropagation(); chrome.close(); }}
    >
      <X size={12} />
    </button>
  </div>;
}

/** A thread tab is named by the index, so a thread titled later renames its tab. */
function ThreadStageTab({ sessionId, chrome }: { sessionId: string; chrome: TabChrome }) {
  const label = useThreadShell(sessionId)?.title || "Agent";
  return <StageTabButton chrome={chrome} title={label} label={label} icon={<Bot size={13} />} />;
}

export function StageTabs({ tabs, activeId, changedPaths, chatTab, onActivate, onClose, onPin }: {
  tabs: StageTab[];
  activeId?: string;
  /** Absolute paths with uncommitted changes. */
  changedPaths: Set<string>;
  chatTab?: ChatTab;
  onActivate(id: string): void;
  onClose(id: string): void;
  onPin(id: string): void;
}) {
  return <div className="stage-tabs" role="tablist">
    {chatTab ? (
      <div
        role="tab"
        tabIndex={0}
        aria-selected={chatTab.active}
        className={`stage-tab chat ${chatTab.active ? "active" : ""}`}
        onClick={() => chatTab.onSelect(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chatTab.onSelect(true); }
        }}
      >
        <span className="stage-tab-icon"><MessageSquare size={13} /></span>
        <span className="stage-tab-label">Chat</span>
        {chatTab.streaming ? <span className="spinner small" aria-label="Agent is working" /> : null}
      </div>
    ) : null}
    {tabs.map((tab) => {
      const chrome: TabChrome = {
        active: tab.id === activeId && !chatTab?.active,
        preview: tab.preview,
        activate: () => { chatTab?.onSelect(false); onActivate(tab.id); },
        close: () => onClose(tab.id),
        pin: () => onPin(tab.id),
      };
      if (tab.kind === "thread") return <ThreadStageTab key={tab.id} sessionId={tab.sessionId} chrome={chrome} />;
      const name = fileName(tab.path);
      const changed = changedPaths.has(tab.path);
      // A diff tab whose file is clean again renders as source, so name it that way.
      const label = tab.view === "diff" && changed ? `${name} (diff)` : name;
      return <StageTabButton
        key={tab.id}
        chrome={chrome}
        title={tab.path}
        label={label}
        icon={<FileKindIcon name={name} size={13} />}
        marker={changed ? <em>M</em> : null}
      />;
    })}
  </div>;
}
