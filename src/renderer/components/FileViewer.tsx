import { useEffect, useState } from "react";
import { ExternalLink, FileWarning } from "lucide-react";
import type { DiffLoadOptions, UiEditor, UiFileContent, UiFileDiff } from "../../shared/workspace-kit-types";
import type { StageFileTab, StageView } from "../../workbench/stage";
import type { CommandContribution, WorkbenchActions } from "../extension-system";
import { errorMessage } from "../../workbench/error-message";
import { FileSource, lineCount } from "./FileSource";
import { DiffPane } from "./DiffPane";
import { formatBytes } from "../format-bytes";
import { commandRefusal, useHostCapabilities } from "../use-host-capabilities";
import { tooltipProps } from "./ui/Tooltip";
import { Empty } from "./ui/Feedback";

/** What a load error says about the file: gone with its project, gone itself, or something else. */
export function missingReason(message: string): "project" | "file" | undefined {
  if (/not a known Tau project/u.test(message)) return "project";
  return /\bENOENT\b/u.test(message) ? "file" : undefined;
}

export function FileViewer({ tab, relativePath, changed, stat, editor, commands = [], actions, loadFile, loadDiff, onChangeView, onOpenInEditor, onClose }: {
  tab: StageFileTab;
  relativePath: string;
  /** The working tree differs from HEAD for this file, so a diff exists. */
  changed: boolean;
  /** Lines added and removed in the working tree, beside the view switch as in the design. */
  stat?: { added: number; removed: number };
  editor?: UiEditor;
  /** Commands an extension offers on the `file-tab` surface; they read the tab from `actions.activeStageTab()`. */
  commands?: readonly CommandContribution[];
  actions?: WorkbenchActions;
  loadFile(path: string): Promise<UiFileContent>;
  loadDiff(path: string, options?: DiffLoadOptions): Promise<UiFileDiff>;
  onChangeView(view: StageView): void;
  onOpenInEditor(path: string): void;
  onClose?(): void;
}) {
  const [content, setContent] = useState<UiFileContent>();
  const [error, setError] = useState<string>();
  const [mode, setMode] = useState<"unified" | "split">("unified");
  const { readOnly } = useHostCapabilities();
  const view: StageView = tab.view === "diff" && !changed ? "source" : tab.view;

  useEffect(() => {
    let cancelled = false;
    setContent(undefined);
    setError(undefined);
    // The source reads paths inside the project; a tab opened by its absolute path is one too.
    loadFile(relativePath).then(
      (next) => { if (!cancelled) setContent(next); },
      (reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason)); },
    );
    return () => { cancelled = true; };
  }, [loadFile, relativePath]);

  const meta = content?.kind === "text"
    ? `${formatBytes(content.size)} · ${lineCount(content.text ?? "")} ${lineCount(content.text ?? "") === 1 ? "line" : "lines"}`
    : content ? formatBytes(content.size) : undefined;

  return <div className="stage-pane" data-view={view}>
    <header className="stage-pane-header">
      <strong title={tab.path}>{relativePath}</strong>
      {meta ? <small>{meta}</small> : null}
      <span className="spacer" />
      {changed ? (
        <div className="toggle-group" role="tablist" aria-label="View">
          <button className={view === "diff" ? "active" : ""} onClick={() => onChangeView("diff")}>Diff</button>
          <button className={view === "source" ? "active" : ""} onClick={() => onChangeView("source")}>Source</button>
        </div>
      ) : null}
      {changed && stat && Number.isFinite(stat.added) && Number.isFinite(stat.removed) ? <small className="stage-pane-stat"><span className="stat-add">+{stat.added}</span> <span className="stat-del">−{stat.removed}</span></small> : null}
      {view === "diff" ? (
        <div className="toggle-group" aria-label="Diff layout">
          <button className={mode === "unified" ? "active" : ""} onClick={() => setMode("unified")}>Unified</button>
          <button className={mode === "split" ? "active" : ""} onClick={() => setMode("split")}>Split</button>
        </div>
      ) : null}
      {actions ? commands.map((command) => {
        const refused = commandRefusal(command, readOnly);
        return <button
          key={command.id}
          className="text-button"
          disabled={Boolean(refused)}
          {...tooltipProps(refused)}
          onClick={() => { Promise.resolve(command.run(actions)).catch((reason: unknown) => actions.notify(errorMessage(reason))); }}
        >{command.label}</button>;
      }) : null}
      {editor ? (
        <button className="text-button" title={`Open in ${editor.name}`} onClick={() => onOpenInEditor(tab.path)}>
          <span>Open in {editor.name}</span> <ExternalLink size={11} />
        </button>
      ) : null}
    </header>
    {view === "diff"
      ? <DiffPane path={relativePath} mode={mode} loadDiff={loadDiff} />
      : error
        ? <Empty
          icon={<FileWarning size={20} />}
          title={missingReason(error) ? "File not found" : "Could not open this file"}
          description={<><code>{relativePath}</code><br />{missingReason(error) === "file"
            ? "It is not in this project any more."
            : missingReason(error) === "project" ? "Its project is not open in Tau any more." : error}</>}
        >{onClose ? <button type="button" className="text-button" onClick={onClose}>Close</button> : null}</Empty>
        : !content
          ? <div className="stage-empty">Loading…</div>
          : content.kind === "image"
            ? <div className="stage-image"><img src={content.dataUrl} alt={content.name} /></div>
            : content.kind === "binary"
              ? <div className="stage-empty">Binary file ({formatBytes(content.size)}) — nothing to show here.</div>
              : <FileSource content={content} line={tab.line} reveal={tab.reveal} />}
  </div>;
}
