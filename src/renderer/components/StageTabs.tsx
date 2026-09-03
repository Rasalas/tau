import { MessageSquare, X } from "lucide-react";
import type { StageTab } from "../stage";
import { FileKindIcon } from "./FileKindIcon";

function tabName(tab: StageTab): string {
  return tab.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? tab.path;
}

export interface ChatTab {
  active: boolean;
  streaming: boolean;
  onSelect(active: boolean): void;
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
      const active = tab.id === activeId && !chatTab?.active;
      const name = tabName(tab);
      const changed = changedPaths.has(tab.path);
      // A diff tab whose file is clean again renders as source, so name it that way.
      const label = tab.view === "diff" && changed ? `${name} (diff)` : name;
      return <div
        key={tab.id}
        role="tab"
        tabIndex={0}
        aria-selected={active}
        title={tab.path}
        className={`stage-tab ${active ? "active" : ""} ${tab.preview ? "preview" : ""}`}
        onClick={() => { chatTab?.onSelect(false); onActivate(tab.id); }}
        onDoubleClick={() => onPin(tab.id)}
        onAuxClick={(event) => { if (event.button === 1) onClose(tab.id); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); chatTab?.onSelect(false); onActivate(tab.id); }
        }}
      >
        <span className="stage-tab-icon"><FileKindIcon name={name} size={13} /></span>
        <span className="stage-tab-label">{label}</span>
        {changed ? <em>M</em> : null}
        <button
          className="stage-tab-close"
          aria-label={`Close ${label}`}
          tabIndex={-1}
          onClick={(event) => { event.stopPropagation(); onClose(tab.id); }}
        >
          <X size={12} />
        </button>
      </div>;
    })}
  </div>;
}
