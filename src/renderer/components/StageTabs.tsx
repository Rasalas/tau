import { X } from "lucide-react";
import type { StageTab } from "../stage";
import { FileKindIcon } from "./FileKindIcon";

function tabName(tab: StageTab): string {
  return tab.path.split(/[\\/]/u).filter(Boolean).at(-1) ?? tab.path;
}

export function StageTabs({ tabs, activeId, changedPaths, onActivate, onClose, onPin }: {
  tabs: StageTab[];
  activeId?: string;
  /** Absolute paths with uncommitted changes. */
  changedPaths: Set<string>;
  onActivate(id: string): void;
  onClose(id: string): void;
  onPin(id: string): void;
}) {
  return <div className="stage-tabs" role="tablist">
    {tabs.map((tab) => {
      const active = tab.id === activeId;
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
        onClick={() => onActivate(tab.id)}
        onDoubleClick={() => onPin(tab.id)}
        onAuxClick={(event) => { if (event.button === 1) onClose(tab.id); }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onActivate(tab.id); }
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
