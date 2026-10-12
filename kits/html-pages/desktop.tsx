import { AppWindow } from "lucide-react";
import type { DesktopExtension, DesktopExtensionContext, HostExtensionClient, WorkbenchActions } from "tau";
import { createPageCard } from "./page-card.js";
import { PageView } from "./page-view.js";
import { HTML_PAGES_EXTENSION_ID, HTML_PAGE_STAGE_TAB, isShowHtmlPage } from "./protocol.js";

interface PageTabParams extends Record<string, unknown> {
  threadId: string;
  id: string;
  title: string;
}

/**
 * HTML Pages Kit's desktop half: the card that draws a page in the thread, and
 * the stage tab it can be opened in. The frame, its isolation and its
 * route come from core (ADR 0032).
 */
const htmlPages: DesktopExtension = {
  id: HTML_PAGES_EXTENSION_ID,
  name: "HTML Pages",
  activate(context: DesktopExtensionContext) {
    const disposers: Array<() => void> = [];
    disposers.push(context.registerToolCard({
      id: "html-pages.page",
      match: (tool) => isShowHtmlPage(tool.name),
      profiles: ["desktop", "web", "compact"],
      Component: createPageCard(context.host),
    }));
    disposers.push(context.registerStageTab<PageTabParams>({
      kind: HTML_PAGE_STAGE_TAB,
      profiles: ["desktop", "web"],
      title: (params) => params.title || "HTML page",
      Icon: AppWindow,
      render: (params, handle, actions) => <PageTab params={params} setTitle={handle.setTitle} actions={actions} host={context.host} />,
      restore: (params) => Boolean(params.threadId && params.id),
    }));
    return () => { for (const dispose of disposers.reverse()) dispose(); };
  },
};

function PageTab({ params, setTitle, actions, host }: { params: PageTabParams; setTitle(title: string): void; actions: WorkbenchActions; host: HostExtensionClient }) {
  return (
    <div className="html-page-tab">
      <PageView host={host} actions={actions} threadId={params.threadId} pageId={params.id} variant="tab" onTitle={setTitle} />
    </div>
  );
}

export default htmlPages;
