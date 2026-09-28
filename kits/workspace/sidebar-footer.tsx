import { ArrowLeft, Settings } from "lucide-react";
import { READ_ONLY_REASON, tooltipProps, useOpenPage, useWorkbenchShell, type PageContribution, type WorkbenchActions } from "tau";

const noBadge = () => undefined;
const noSummary = () => undefined;

function openOrClose(page: PageContribution, current: boolean, actions: WorkbenchActions) {
  if (current) actions.closePage?.();
  else actions.openPage?.(page.id);
}

/** A page's entry, with the count its kit reports (open pull requests, say); a prominent one names itself. */
function PageButton({ page, current, actions }: { page: PageContribution; current: boolean; actions: WorkbenchActions }) {
  const count = (page.useBadge ?? noBadge)();
  const label = count ? `${page.label}, ${count}` : page.label;
  const shown = count && count > 99 ? "99+" : count;
  return (
    <button
      type="button"
      className={`${current ? "active " : ""}${page.prominent ? "page-named" : ""}`.trim() || undefined}
      aria-current={current ? "page" : undefined}
      {...tooltipProps(label, { side: "top" })}
      aria-label={label}
      onClick={() => openOrClose(page, current, actions)}
    >
      {page.Icon ? <page.Icon size={15} /> : page.prominent ? null : page.label.slice(0, 1)}
      {page.prominent ? <span>{page.label}</span> : null}
      {count ? <span className={page.prominent ? "page-count" : "page-badge"} aria-hidden="true">{shown}</span> : null}
    </button>
  );
}

/** A page that sums itself up in the foot (Usage's month): the figure, else its icon. */
function SummaryButton({ page, current, actions }: { page: PageContribution; current: boolean; actions: WorkbenchActions }) {
  const summary = (page.useSummary ?? noSummary)();
  if (!summary) return <PageButton page={page} current={current} actions={actions} />;
  return (
    <button
      type="button"
      className={`sidebar-summary${current ? " active" : ""}`}
      aria-current={current ? "page" : undefined}
      {...tooltipProps(summary.hint ?? page.label, { side: "top" })}
      aria-label={`${page.label}: ${summary.hint ?? summary.text}`}
      onClick={() => openOrClose(page, current, actions)}
    >
      <span className="sidebar-summary-full">{summary.text}</span>
      <span className="sidebar-summary-short" aria-hidden="true">{summary.short ?? summary.text}</span>
    </button>
  );
}

/**
 * The sidebar's foot, as the design draws it: prominent pages with their
 * label and count (Reviews), Settings, the other pages as icons and the
 * commands kits put here, and at the end a page's figure (Usage's month).
 * While a page shows, Back leads the row and the page's own entry is marked.
 */
export function SidebarFooter({ actions, readOnly }: { actions: WorkbenchActions; readOnly: boolean }) {
  const { registry } = useWorkbenchShell();
  const open = useOpenPage();
  const pages = registry.getPages();
  const named = pages.filter((page) => page.prominent && !page.useSummary);
  const icons = pages.filter((page) => !page.prominent && !page.useSummary);
  const summaries = pages.filter((page) => page.useSummary);
  const commands = registry.getCommandsFor("sidebar-footer").slice().sort((a, b) => a.label.localeCompare(b.label));
  return (
    <div className="sidebar-footer" data-page={open?.id}>
      {open ? (
        <button type="button" className="sidebar-back" {...tooltipProps("Back to the thread", { side: "top", shortcut: "Esc" })} onClick={() => actions.closePage?.()}>
          <ArrowLeft size={15} /><span>Back</span>
        </button>
      ) : null}
      {named.map((page) => <PageButton key={page.id} page={page} current={open?.id === page.id} actions={actions} />)}
      <button type="button" {...tooltipProps("Settings", { side: "top", shortcut: registry.keybindingLabel("runtime.settings") })} aria-label="Settings" onClick={() => actions.openSettings()}>
        <Settings size={15} />
      </button>
      {icons.map((page) => <PageButton key={page.id} page={page} current={open?.id === page.id} actions={actions} />)}
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
      {summaries.length ? <span className="sidebar-footer-end">
        {summaries.map((page) => <SummaryButton key={page.id} page={page} current={open?.id === page.id} actions={actions} />)}
      </span> : null}
    </div>
  );
}
