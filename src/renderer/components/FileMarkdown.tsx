import { useContext, useMemo, useState, useSyncExternalStore } from "react";
import { Code2, Eye } from "lucide-react";
import type { UiFileContent } from "../../shared/workspace-kit-types";
import type { StageFileTab, StageView, WorkspaceResourceOrigin } from "../../workbench/stage";
import { formatBytes } from "../format-bytes";
import { WorkbenchContext } from "../workbench-context";
import { WorkspaceResourcesScope, type WorkspaceResources } from "../workspace-resource-context";
import type { MediaLoader } from "./FileMedia";
import { Markdown, type MarkdownComponents } from "./Markdown";
import { renderedMarkdown } from "./rendered-markdown";
import { tooltipProps } from "./ui/Tooltip";
import { WorkspaceImage } from "./WorkspaceImage";
import { WorkspaceVideo, isVideoPath } from "./WorkspaceVideo";

/** `.mdx` stays source: its JSX does not render as Markdown. */
export const isMarkdownFile = (path: string): boolean => /\.(?:md|markdown)$/iu.test(path);

/** `link` read from inside `directory`. A path that climbs above its start keeps the `..`, so the reader refuses it. */
export function resolveBeside(directory: string, link: string): string {
  const root = /^(?:[A-Za-z]:)?\//u.exec(directory)?.[0] ?? "";
  const parts: string[] = [];
  for (const part of `${directory.slice(root.length)}/${link}`.split("/")) {
    if (part === "" || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (parts.length > 0 && parts.at(-1) !== "..") parts.pop();
    else if (!root) parts.push("..");
  }
  return root + parts.join("/");
}

const directoryOf = (path: string): string => {
  const slash = path.lastIndexOf("/");
  return slash > 0 ? path.slice(0, slash) : slash === 0 ? "/" : "";
};
/** A source that names a file of the workspace, not an address. */
const isBesideSource = (src: string): boolean => !/^(?:[A-Za-z][A-Za-z0-9+.-]*:|\/|#|\?)/u.test(src);

export interface MarkdownView {
  /** The file is Markdown, loaded as text and shown as source: the toggle applies. */
  available: boolean;
  rendered: boolean;
  toggle(): void;
}

/**
 * Rendered or source for a Markdown file in a file tab. A line asked for shows
 * the source, which is what the line counts, until the toggle is used.
 */
export function useMarkdownView(path: string, tab: Pick<StageFileTab, "line" | "reveal">, content: UiFileContent | undefined, view: StageView): MarkdownView {
  const preferred = useSyncExternalStore(renderedMarkdown.subscribe, renderedMarkdown.get);
  const request = tab.line ? `${tab.line}:${tab.reveal ?? 0}` : undefined;
  const [released, setReleased] = useState<string>();
  const available = view === "source" && content?.kind === "text" && isMarkdownFile(path);
  const rendered = available && preferred && (request === undefined || released === request);
  return { available, rendered, toggle: () => { renderedMarkdown.set(!rendered); setReleased(request); } };
}

export function MarkdownViewToggle({ view }: { view: MarkdownView }) {
  if (!view.available) return null;
  const label = view.rendered ? "Show markdown source" : "Show rendered markdown";
  return <button type="button" className="stage-pane-action" aria-label={label} {...tooltipProps(label)} onClick={view.toggle}>
    {view.rendered ? <Code2 size={14} /> : <Eye size={14} />}
  </button>;
}

/** Images and videos beside the document name files of its folder; the images' own reader refuses `..`, so the path is settled here. */
function documentComponents(directory: string): MarkdownComponents {
  const encoded = directory.split("/").map(encodeURIComponent).join("/");
  return {
    img({ src, alt, title, width, height }) {
      const resolved = typeof src === "string" && isBesideSource(src) ? resolveBeside(encoded, src) : src;
      if (typeof resolved === "string" && isVideoPath(resolved)) return <WorkspaceVideo src={resolved} alt={alt} />;
      return <WorkspaceImage src={typeof resolved === "string" ? resolved : undefined} alt={alt} title={title} width={width} height={height} />;
    },
  };
}

/**
 * A Markdown file as the file tab draws it. Its relative links and images
 * name files beside it, not in the workspace's root; the file's own tab
 * origin decides whose workspace they belong to.
 */
export function FileMarkdown({ content, path, origin, loadFile, loadMedia }: {
  content: UiFileContent;
  /** The tab's path as the reader knows it. */
  path: string;
  origin: WorkspaceResourceOrigin | null | undefined;
  loadFile(path: string): Promise<UiFileContent>;
  loadMedia?: MediaLoader | undefined;
}) {
  const workbench = useContext(WorkbenchContext);
  const directory = directoryOf(path);
  const resources = useMemo<WorkspaceResources>(() => ({
    ...(origin ? { origin } : {}),
    available: origin !== null,
    loadFile,
    ...(loadMedia ? { loadMedia } : {}),
    openFile: (link) => {
      // A link to another file's heading opens the file; the heading is not followed.
      const target = link.replace(/#.*$/u, "");
      if (!target) return;
      const beside = resolveBeside(directory, target);
      if (origin === undefined) workbench?.openFile(beside);
      else workbench?.openWorkspaceFile?.(beside, origin);
    },
  }), [directory, loadFile, loadMedia, origin, workbench]);
  const components = useMemo(() => documentComponents(directory), [directory]);
  const text = content.text ?? "";
  return <div className="stage-markdown">
    <div className="stage-markdown-scroll">
      <WorkspaceResourcesScope value={resources}><Markdown components={components}>{text}</Markdown></WorkspaceResourcesScope>
    </div>
    {content.truncated ? <div className="source-note" role="status">Showing the first {formatBytes(text.length)} of {formatBytes(content.size)}. Open the file in an editor for the rest.</div> : null}
  </div>;
}
