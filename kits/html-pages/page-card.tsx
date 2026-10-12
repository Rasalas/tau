import { type ComponentType } from "react";
import { AppWindow } from "lucide-react";
import type { HostExtensionClient, ToolCardProps, UiToolRun, WorkbenchActions } from "tau";
import { pageIdOf } from "./protocol.js";
import { PageView } from "./page-view.js";

function Item({ tool, actions, host }: { tool: UiToolRun; actions: WorkbenchActions; host: HostExtensionClient }) {
  const threadId = actions.activeThread()?.sessionId;
  const pageId = tool.status === "done" ? pageIdOf(tool.output) : undefined;
  const title = typeof tool.args.title === "string" ? tool.args.title : "HTML page";
  const running = tool.status === "running";
  return (
    <section className="html-page" data-state={tool.status}>
      {running || !pageId ? (
        <div className="html-page-line">
          {running ? <span className="spinner tone-current small" aria-hidden="true" /> : <AppWindow size={14} aria-hidden="true" />}
          <span className="html-page-title">{title}</span>
          <span className="html-page-status" data-tone={tool.status === "error" ? "error" : undefined}>{running ? "Preparing" : tool.status === "error" ? "Failed" : ""}</span>
        </div>
      ) : null}
      {!running && !pageId && tool.output?.trim() ? <p className="html-page-reason">{tool.output}</p> : null}
      {pageId && threadId ? <PageView host={host} actions={actions} threadId={threadId} pageId={pageId} variant="card" /> : null}
      {pageId && !threadId ? <p className="html-page-reason">Open the thread to see the page.</p> : null}
    </section>
  );
}

/** The tool card: the page in a sandboxed frame once the call settled, a status line before. */
export function createPageCard(host: HostExtensionClient): ComponentType<ToolCardProps> {
  return function HtmlPageCard({ tools, actions }: ToolCardProps) {
    return <>{tools.map((tool) => <Item key={tool.id} tool={tool} actions={actions} host={host} />)}</>;
  };
}
