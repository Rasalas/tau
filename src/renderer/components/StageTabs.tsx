import { ChevronDown, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { StageTab } from "../../workbench/stage";
import type { ExtensionRegistry, PanelContribution } from "../extension-system";
import { usePlatform } from "../platform-context";
import { useEnvironmentThread } from "../use-environment-thread";
import { useThreadShell } from "../use-thread-shell";
import { Menu, type MenuItem, type MenuSection } from "./Menu";
import { useThreadStore } from "../workbench-context";
import { stageTabGlyph } from "./StageSpine";
import { tooltipProps } from "./ui/Tooltip";

/** What a tab dragged off the strip carries: its id. */
export const STAGE_TAB_DRAG = "application/x-tau-stage-tab";

/** What every tab of the strip does, whatever it holds. */
interface TabChrome {
  id: string;
  active: boolean;
  preview: boolean;
  trace?: boolean | undefined;
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
    data-tab-id={chrome.id}
    {...tooltipProps(title, { side: "bottom" })}
    className={`stage-tab ${chrome.active ? "active" : ""} ${chrome.preview ? "preview" : ""}${chrome.trace ? " trace" : ""}`}
    onClick={chrome.activate}
    onDoubleClick={chrome.pin}
    onContextMenu={(event) => { event.preventDefault(); chrome.openMenu(event, label); }}
    onAuxClick={(event) => { if (event.button === 1) chrome.close(); }}
    draggable
    onDragStart={(event) => event.dataTransfer.setData(STAGE_TAB_DRAG, chrome.id)}
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
function ThreadStageTab({ sessionId, chrome, icon }: { sessionId: string; chrome: TabChrome; icon: ReactNode }) {
  const label = useThreadShell(sessionId)?.title || "Agent";
  return <StageTabButton chrome={chrome} title={label} label={label} icon={icon} />;
}

/** Another machine's thread: its title as that machine lists it, and the machine's glyph. */
function RemoteThreadStageTab({ machine, sessionId, chrome, icon }: { machine: string; sessionId: string; chrome: TabChrome; icon: ReactNode }) {
  const view = useEnvironmentThread(usePlatform().environments, machine, sessionId);
  const label = view?.thread?.title || "Thread";
  return <StageTabButton chrome={chrome} title={`${label} · on ${view?.machineName ?? machine}`} label={label} icon={icon} />;
}

/** A panel's count, which its kit reads with a hook of its own. */
function PanelBadge({ useBadge }: { useBadge: NonNullable<PanelContribution["useBadge"]> }) {
  const count = useBadge();
  return count ? <span className="stage-tab-badge">{count}</span> : null;
}

/** Where the tab strip's context menu is open, and what it may do there. */
interface TabMenu {
  id: string;
  label: string;
  preview: boolean;
  x: number;
  y: number;
}

/** True while the strip's tabs are wider than the strip, so some are scrolled out of view. */
function useOverflow(strip: React.RefObject<HTMLElement | null>, count: number): boolean {
  const [over, setOver] = useState(false);
  useLayoutEffect(() => {
    const element = strip.current;
    if (!element) return undefined;
    const measure = () => {
      setOver(element.scrollWidth > element.clientWidth + 1);
      // A narrower strip keeps the tab in front in view.
      element.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };
    measure();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [strip, count]);
  return over;
}

/** A closed tab's name in "Recently closed": a thread by its title. */
function closedLabel(tab: StageTab, registry: ExtensionRegistry | undefined, title: (sessionId: string) => string | undefined): string {
  if (tab.kind === "thread") return title(tab.sessionId) || "Thread";
  return stageTabGlyph(tab, registry).label;
}

const RECENT_PREFIX = "recent:";

export function StageTabs({
  tabs, activeId, splitId, changedPaths, registry, closed = [], reopenShortcut,
  onActivate, onClose, onPin, onUnpin, onCloseOthers, onCloseToRight, onSplit, onReopen,
}: {
  tabs: StageTab[];
  activeId?: string;
  /** The tab shown beside the active one. */
  splitId?: string | undefined;
  /** Absolute paths with uncommitted changes. */
  changedPaths: ReadonlySet<string>;
  /** Where an extension tab's or a panel's glyph comes from. */
  registry?: ExtensionRegistry | undefined;
  onActivate(id: string): void;
  onClose(id: string): void;
  onPin(id: string): void;
  onUnpin(id: string): void;
  onCloseOthers(id: string): void;
  onCloseToRight(id: string): void;
  /** Shows a tab beside the active one; without an id, joins the panes again. */
  onSplit?: ((id?: string) => void) | undefined;
  /** Tabs closed on this stage, newest first; "All tabs" lists them under "Recently closed". */
  closed?: readonly StageTab[];
  reopenShortcut?: string | undefined;
  onReopen?: ((id: string) => void) | undefined;
}) {
  const threads = useThreadStore();
  const [menu, setMenu] = useState<TabMenu>();
  const [listOpen, setListOpen] = useState(false);
  const strip = useRef<HTMLDivElement>(null);
  const overflow = useOverflow(strip, tabs.length);
  // The tab in front is always in view, however it came there.
  useEffect(() => {
    const active = activeId ? [...strip.current?.children ?? []].find((tab) => (tab as HTMLElement).dataset.tabId === activeId) : undefined;
    active?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [activeId]);
  const menuItems: MenuItem[] = menu ? [
    { id: "close", label: "Close" },
    { id: "close-others", label: "Close others", disabled: tabs.length < 2 },
    { id: "close-right", label: "Close to the right", disabled: tabs.findIndex((tab) => tab.id === menu.id) >= tabs.length - 1 },
    { id: "pin", label: menu.preview ? "Pin" : "Unpin" },
    ...(onSplit ? [{ id: "split", label: menu.id === splitId ? "Unsplit" : "Split right", disabled: tabs.length < 2 }] : []),
  ] : [];
  const runMenu = (action: string) => {
    if (!menu) return;
    if (action === "close") onClose(menu.id);
    else if (action === "close-others") onCloseOthers(menu.id);
    else if (action === "close-right") onCloseToRight(menu.id);
    else if (action === "pin") (menu.preview ? onPin : onUnpin)(menu.id);
    else onSplit?.(menu.id === splitId ? undefined : menu.id);
  };

  return <div className="stage-tabs-frame">
    <div ref={strip} className="stage-tabs" role="tablist">
      {tabs.map((tab) => {
        const chrome: TabChrome = {
          id: tab.id,
          active: tab.id === activeId || tab.id === splitId,
          preview: tab.preview,
          trace: tab.kind === "file" && tab.trace,
          activate: () => onActivate(tab.id),
          close: () => onClose(tab.id),
          pin: () => onPin(tab.id),
          openMenu: (event, label) => setMenu({ id: tab.id, label, preview: tab.preview, x: event.clientX, y: event.clientY }),
        };
        const { icon, label } = stageTabGlyph(tab, registry, 12);
        if (tab.kind === "thread" && tab.machine) return <RemoteThreadStageTab key={tab.id} machine={tab.machine} sessionId={tab.sessionId} chrome={chrome} icon={icon} />;
        if (tab.kind === "thread") return <ThreadStageTab key={tab.id} sessionId={tab.sessionId} chrome={chrome} icon={icon} />;
        if (tab.kind === "panel") {
          const panel = registry?.getPanels().find((entry) => entry.id === tab.panelId);
          return <StageTabButton
            key={tab.id}
            chrome={chrome}
            title={label}
            label={label}
            icon={icon}
            marker={panel?.useBadge ? <PanelBadge useBadge={panel.useBadge} /> : null}
          />;
        }
        if (tab.kind === "extension") {
          return <StageTabButton
            key={tab.id}
            chrome={chrome}
            title={tab.title}
            label={label}
            icon={icon}
            marker={tab.dirty ? <em className="stage-tab-dirty" {...tooltipProps("Unsaved work")} aria-label="Unsaved work">●</em> : null}
          />;
        }
        const changed = changedPaths.has(tab.path);
        // A diff tab whose file is clean again renders as source, so name it that way.
        return <StageTabButton
          key={tab.id}
          chrome={chrome}
          title={tab.trace ? `${tab.path} · opened by the agent` : tab.path}
          label={tab.view === "diff" && changed ? `${label} (diff)` : label}
          icon={icon}
          marker={changed ? <em className="stage-tab-changed" {...tooltipProps("Changed")} aria-label="Changed">M</em> : null}
        />;
      })}
    </div>
    {overflow || (onReopen && closed.length > 0) ? <span className="menu-anchor stage-tabs-overflow">
      <button
        type="button"
        className="stage-tool"
        aria-label="All tabs"
        aria-haspopup="menu"
        aria-expanded={listOpen}
        {...tooltipProps("All tabs", { side: "bottom" })}
        onClick={() => setListOpen((open) => !open)}
      ><ChevronDown size={15} /></button>
      {listOpen ? <Menu
        // Without overflow the button follows the tabs near the stage's left edge, so the menu opens rightwards.
        align={overflow ? "right" : "left"}
        label="All tabs"
        sections={[
          { items: tabs.map((tab) => ({ id: tab.id, label: stageTabGlyph(tab, registry).label, icon: stageTabGlyph(tab, registry).icon, selected: tab.id === activeId })) },
          ...(onReopen && closed.length > 0 ? [{
            heading: "Recently closed",
            items: closed.map((tab, index) => ({
              id: `${RECENT_PREFIX}${tab.id}`,
              label: closedLabel(tab, registry, (sessionId) => threads.getThread(sessionId)?.title),
              icon: stageTabGlyph(tab, registry).icon,
              ...(index === 0 && reopenShortcut ? { hint: reopenShortcut } : {}),
              ...(tab.kind === "extension" && registry?.getStageTabKind(tab.tabKind)?.reopenHint ? { description: registry.getStageTabKind(tab.tabKind)!.reopenHint } : {}),
            })),
          } satisfies MenuSection] : []),
        ]}
        onSelect={(id) => {
          setListOpen(false);
          if (id.startsWith(RECENT_PREFIX)) onReopen?.(id.slice(RECENT_PREFIX.length));
          else onActivate(id);
        }}
        onClose={() => setListOpen(false)}
      /> : null}
    </span> : null}
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
