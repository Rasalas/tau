import { ArrowLeft, Settings } from "lucide-react";
import { READ_ONLY_REASON, tooltipProps, useOpenPage, useWorkbenchShell, type WorkbenchActions } from "tau";

/**
 * The sidebar's foot: Settings, then every app page a kit added, then the
 * commands kits put here. While a page shows, Back leads the row and the
 * page's own entry is marked, the way Settings' column ends in Back.
 */
export function SidebarFooter({ actions, readOnly }: { actions: WorkbenchActions; readOnly: boolean }) {
  const { registry } = useWorkbenchShell();
  const open = useOpenPage();
  const pages = registry.getPages();
  const commands = registry.getCommandsFor("sidebar-footer").slice().sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div className="sidebar-footer" data-page={open?.id}>
      {open ? (
        <button type="button" className="sidebar-back" {...tooltipProps("Back to the thread", { side: "top", shortcut: "Esc" })} onClick={() => actions.closePage?.()}>
          <ArrowLeft size={15} /><span>Back</span>
        </button>
      ) : null}
      <button type="button" {...tooltipProps("Settings", { side: "top", shortcut: registry.keybindingLabel("runtime.settings") })} aria-label="Settings" onClick={() => actions.openSettings()}>
        <Settings size={15} />
      </button>
      {pages.map((page) => {
        const current = open?.id === page.id;
        return (
          <button
            key={page.id}
            type="button"
            className={current ? "active" : undefined}
            aria-current={current ? "page" : undefined}
            {...tooltipProps(page.label, { side: "top" })}
            aria-label={page.label}
            onClick={() => (current ? actions.closePage?.() : actions.openPage?.(page.id))}
          >
            {page.Icon ? <page.Icon size={15} /> : page.label.slice(0, 1)}
          </button>
        );
      })}
      {commands.map((command) => (
        <button
          key={command.id}
          type="button"
          {...tooltipProps(readOnly && command.access !== "read" ? READ_ONLY_REASON : command.label, { side: "top" })}
          aria-label={command.label}
          disabled={readOnly && command.access !== "read"}
          onClick={() => { void registry.executeCommand(command.id, actions).catch((error) => actions.notify(String(error))); }}
        >
          {command.Icon ? <command.Icon size={15} /> : command.label}
        </button>
      ))}
    </div>
  );
}
