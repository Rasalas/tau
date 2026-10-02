import { ChevronLeft, CircleArrowUp, Settings } from "lucide-react";
import { READ_ONLY_REASON, tooltipProps, useAppUpdate, useOpenPage, useWorkbenchShell, type PageContribution, type WorkbenchActions } from "tau";

const noBadge = () => undefined;
const noSummary = () => undefined;

/**
 * A page's entry: its icon, with the count its kit reports (open pull requests, say) as a badge.
 * A prominent page (Reviews) draws a notification dot; its label and count stay in the tooltip.
 */
function PageButton({ page, actions }: { page: PageContribution; actions: WorkbenchActions }) {
  const count = (page.useBadge ?? noBadge)();
  const label = count ? `${page.label}, ${count}` : page.label;
  const shown = count && count > 99 ? "99+" : count;
  return (
    <button type="button" {...tooltipProps(label, { side: "top" })} aria-label={label} onClick={() => actions.openPage?.(page.id)}>
      {page.Icon ? <page.Icon size={15} /> : page.label.slice(0, 1)}
      {count ? <span className={page.prominent ? "page-dot" : "page-badge"} aria-hidden="true">{page.prominent ? null : shown}</span> : null}
    </button>
  );
}

/** A page that sums itself up in the foot (Usage's month): the figure, else its icon. */
function SummaryButton({ page, actions }: { page: PageContribution; actions: WorkbenchActions }) {
  const summary = (page.useSummary ?? noSummary)();
  if (!summary) return <PageButton page={page} actions={actions} />;
  return (
    <button
      type="button"
      className="sidebar-summary"
      {...tooltipProps(summary.hint ?? page.label, { side: "top" })}
      aria-label={`${page.label}: ${summary.hint ?? summary.text}`}
      onClick={() => actions.openPage?.(page.id)}
    >
      <span className="sidebar-summary-full">{summary.text}</span>
      <span className="sidebar-summary-short" aria-hidden="true">{summary.short ?? summary.text}</span>
    </button>
  );
}

/** A page's own drawing for the foot (Usage's juicebars), else its figure, else its icon. */
function PageSummarySlot({ page, actions }: { page: PageContribution; actions: WorkbenchActions }) {
  if (page.Summary) return <page.Summary actions={actions} />;
  return <SummaryButton page={page} actions={actions} />;
}

/** A downloaded release waits for a restart; the toast may be closed, this stays. */
function UpdateButton() {
  const update = useAppUpdate();
  if (!update) return null;
  const label = `Tau ${update.version} is ready: restart to update`;
  return (
    <button type="button" className="sidebar-update" {...tooltipProps(label, { side: "top" })} aria-label={label} onClick={() => update.install()}>
      <CircleArrowUp size={15} />
    </button>
  );
}

/**
 * The sidebar's foot: Reviews and its notification dot, the other pages and commands;
 * at the right, the pages' summaries, a waiting update and Settings.
 * While a page shows, the foot is Back alone, as Settings' column ends.
 */
export function SidebarFooter({ actions, readOnly }: { actions: WorkbenchActions; readOnly: boolean }) {
  const { registry } = useWorkbenchShell();
  const open = useOpenPage();
  const pages = registry.getPages();
  const sums = (page: PageContribution) => Boolean(page.Summary || page.useSummary);
  const icons = [...pages.filter((page) => page.prominent && !sums(page)), ...pages.filter((page) => !page.prominent && !sums(page))];
  const summaries = pages.filter(sums);
  const commands = registry.getCommandsFor("sidebar-footer").slice().sort((a, b) => a.label.localeCompare(b.label));
  if (open) {
    return (
      <div className="sidebar-footer" data-page={open.id}>
        <button type="button" className="sidebar-back" {...tooltipProps("Back to the thread", { side: "top", shortcut: "Esc" })} onClick={() => actions.closePage?.()}>
          <ChevronLeft size={15} /><span>Back to thread</span>
        </button>
      </div>
    );
  }
  return (
    <div className="sidebar-footer">
      {icons.map((page) => <PageButton key={page.id} page={page} actions={actions} />)}
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
      <span className="sidebar-footer-end">
        {summaries.map((page) => <PageSummarySlot key={page.id} page={page} actions={actions} />)}
        <UpdateButton />
        <button type="button" {...tooltipProps("Settings", { side: "top", shortcut: registry.keybindingLabel("runtime.settings") })} aria-label="Settings" onClick={() => actions.openSettings()}>
          <Settings size={14} />
        </button>
      </span>
    </div>
  );
}
