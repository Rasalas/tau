import { useState } from "react";
import type { UiToolRun } from "../../shared/contracts";
import type { ExtensionRegistry } from "../extension-system";

function seconds(from: number, to: number): string {
  return `${Math.max(1, Math.round((to - from) / 1000))}s`;
}

function ToolRun({ tool, registry }: { tool: UiToolRun; registry: ExtensionRegistry }) {
  const running = tool.status === "running";
  // A running tool shows what it has produced so far without needing a click.
  const [collapsed, setCollapsed] = useState(false);
  const view = registry.presentTool(tool);
  const showOutput = Boolean(tool.output) && (running ? !collapsed : collapsed);

  return (
    <div className={`tool-run tone-${view.tone}`}>
      <button className="tool-run-line" onClick={() => setCollapsed((value) => !value)}>
        <span className="tool-run-glyph">{view.glyph}</span>
        <span className="tool-run-name">{view.title}</span>
        <span className="tool-run-detail" title={view.detail}>{view.detail}</span>
        <span className={`tool-run-state ${tool.status}`}>
          {running
            ? seconds(tool.startedAt, Date.now())
            : tool.status === "error"
              ? "!"
              : tool.endedAt ? seconds(tool.startedAt, tool.endedAt) : "✓"}
        </span>
      </button>
      {showOutput ? <pre className="tool-output">{tool.output}</pre> : null}
    </div>
  );
}

export function ToolGroup({ tools, registry }: { tools: UiToolRun[]; registry: ExtensionRegistry }) {
  if (tools.length === 0) return null;
  const live = tools.filter((tool) => tool.status === "running").length;
  const done = tools.length - live;

  return (
    <section className="transcript-card">
      <header className="tool-group-header">
        {live > 0 ? <span className="spinner acid small" /> : null}
        <b>{live > 0 ? "RUNNING TOOLS" : "TOOL RUNS"}</b>
        <span>{done} done{live > 0 ? ` · ${live} live` : ""}</span>
      </header>
      {tools.map((tool) => <ToolRun key={tool.id} tool={tool} registry={registry} />)}
    </section>
  );
}
