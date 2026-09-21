import { Bot, MessageSquare, SquareDashed, X } from "lucide-react";
import { useState, type ReactNode } from "react";
import type { StageTab } from "../../workbench/stage";
import type { ExtensionRegistry } from "../extension-system";
import { useThreadShell } from "../use-thread-shell";
import { FileKindIcon } from "./FileKindIcon";
import { Menu, type MenuItem } from "./Menu";

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
  openMenu(event: { clientX: number; clientY: number }, label: string): void;
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
    onContextMenu={(event) => { event.preventDefault(); chrome.openMenu(event, label); }}
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

/** Where the tab strip's context menu is open, and what it may do there. */
interface TabMenu {
  id: string;
  label: string;
  preview: boolean;
  x: number;
  y: number;
}

export function StageTabs({
  tabs, activeId, changedPaths, chatTab, registry,
  onActivate, onClose, onPin, onUnpin, onCloseOthers, onCloseToRight,
}: {
  tabs: StageTab[];
  activeId?: string;
  /** Absolute paths with uncommitted changes. */
  changedPaths: Set<string>;
  chatTab?: ChatTab;
  /** Where an extension tab's glyph comes from. */
  registry?: ExtensionRegistry;
  onActivate(id: string): void;
  onClose(id: string): void;
  onPin(id: string): void;
  onUnpin(id: string): void;
  onCloseOthers(id: string): void;
  onCloseToRight(id: string): void;
}) {
  const [menu, setMenu] = useState<TabMenu>();
  const menuItems: MenuItem[] = menu ? [
    { id: "close", label: "Close" },
    { id: "close-others", label: "Close others", disabled: tabs.length < 2 },
    { id: "close-right", label: "Close to the right", disabled: tabs.findIndex((tab) => tab.id === menu.id) >= tabs.length - 1 },
    { id: "pin", label: menu.preview ? "Pin" : "Unpin" },
  ] : [];
  const runMenu = (action: string) => {
    if (!menu) return;
    if (action === "close") onClose(menu.id);
    else if (action === "close-others") onCloseOthers(menu.id);
    else if (action === "close-right") onCloseToRight(menu.id);
    else if (action === "pin") (menu.preview ? onPin : onUnpin)(menu.id);
  };

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
        openMenu: (event, label) => setMenu({ id: tab.id, label, preview: tab.preview, x: event.clientX, y: event.clientY }),
      };
      if (tab.kind === "thread") return <ThreadStageTab key={tab.id} sessionId={tab.sessionId} chrome={chrome} />;
      if (tab.kind === "extension") {
        const Icon = registry?.getStageTabKind(tab.tabKind)?.Icon ?? SquareDashed;
        return <StageTabButton
          key={tab.id}
          chrome={chrome}
          title={tab.title}
          label={tab.title}
          icon={<Icon size={13} />}
          marker={tab.dirty ? <em title="Unsaved work">●</em> : null}
        />;
      }
      const name = fileName(tab.path);
      const changed = changedPaths.has(tab.path);
      // A diff tab whose file is clean again renders as source, so name it that way.
      return <StageTabButton
        key={tab.id}
        chrome={chrome}
        title={tab.path}
        label={tab.view === "diff" && changed ? `${name} (diff)` : name}
        icon={<FileKindIcon name={name} size={13} />}
        marker={changed ? <em>M</em> : null}
      />;
    })}
    {menu ? <div className="stage-tab-menu" style={{ left: menu.x, top: menu.y }}>
      <Menu
        align="left"
        heading={menu.label}
        items={menuItems}
        onSelect={runMenu}
        onClose={() => setMenu(undefined)}
      />
    </div> : null}
  </div>;
}
