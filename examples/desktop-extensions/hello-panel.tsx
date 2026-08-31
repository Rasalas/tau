import { useWorkbench, type DesktopExtension } from "tau";
import { Sparkles } from "lucide-react";

/**
 * A minimal desktop extension. Copy this file to ~/.tau/extensions/ (or to
 * <project>/.tau/extensions/ in a project Pi trusts) and run /reload in Tau.
 */
function HelloPanel() {
  const { snapshot, tools } = useWorkbench();
  return (
    <div style={{ padding: 16, display: "grid", gap: 8, font: "13px/1.5 var(--sans)", color: "var(--ink-2)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--acid)" }}>
        <Sparkles size={14} /> <strong>Hello from a runtime extension</strong>
      </div>
      <div>Thread: {snapshot?.sessionTitle ?? "none"}</div>
      <div>Model: {snapshot?.model?.name ?? "none"}</div>
      <div>Tools in this turn: {tools.length}</div>
    </div>
  );
}

const extension: DesktopExtension = {
  id: "example.hello",
  name: "Hello Panel",
  activate(plugin) {
    plugin.registerPanel({ id: "hello", label: "Hello", glyph: "signals", order: 90, Component: HelloPanel });
    plugin.registerCommand({ id: "hello.open", label: "Open Hello panel", group: "Extensions", run: (app) => app.openPanel("hello") });
  },
};

export default extension;
