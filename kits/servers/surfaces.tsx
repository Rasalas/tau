import { lazy, Suspense, useEffect } from "react";
import { Server } from "lucide-react";
import { Spinner, type DesktopExtensionContext, type RegionProps } from "tau";
import { createCompactGlyph, createCompactPanel } from "./compact-panel.js";
import { DEPLOY_EVENT } from "./deploy-protocol.js";
import { DRIFT_EVENT } from "./drift-protocol.js";
import type { DriftFeed } from "./drift-view.js";
import type { ServerViewParts, TerminalRunService } from "./server-view.js";
import {
  WORKSPACE_STORE_SERVICE, createChangesSection, createRailSection, createRowMark, createTitleChip, openTarget, useServersStatus, worstTarget,
  type TargetTabParams, type WorkspaceStoreSlice,
} from "./status-parts.js";
import { ServersStatusStore } from "./status-store.js";
import { SERVER_TARGET_TAB, SERVERS_COMPACT_PANEL } from "./view-protocol.js";

// Opened on demand; its code stays out of the kit's first evaluation.
const ServerView = lazy(() => import("./server-view.js"));
const TERMINAL_RUN_SERVICE = "tau.terminal/run";

const isParams = (params: Record<string, unknown>): params is TargetTabParams => typeof params.workspace === "string" && typeof params.targetId === "string";

/**
 * The server view and the status around the workbench: the stage tab, the
 * title-bar mark, the Changes section, the rail's section and row mark, and a
 * compact client's sheet, which is only offered for a project with servers.
 */
export function registerServerSurfaces(context: DesktopExtensionContext, drift: DriftFeed): () => void {
  const store = new ServersStatusStore(context.host);
  let terminal: TerminalRunService | undefined;
  let workspace: WorkspaceStoreSlice | undefined;
  const parts: ServerViewParts = { store, host: context.host, drift, terminal: () => terminal };

  let sheet: (() => void) | undefined;
  const showSheet = (shown: boolean) => {
    if (shown && !sheet) {
      sheet = context.registerPanel({ id: SERVERS_COMPACT_PANEL, label: "Servers", Icon: createCompactGlyph(store), order: 30, profiles: ["compact"], Component: createCompactPanel(parts) });
    } else if (!shown && sheet) {
      sheet();
      sheet = undefined;
    }
  };
  function CompactSheetOffer({ snapshot }: RegionProps) {
    const { status } = useServersStatus(store, snapshot?.cwd);
    const shown = Boolean(status?.targets.length);
    useEffect(() => { showSheet(shown); }, [shown]);
    return null;
  }

  const disposers = [
    context.registerStageTab<TargetTabParams>({
      kind: SERVER_TARGET_TAB,
      profiles: ["desktop", "web"],
      title: () => "Server",
      Icon: Server,
      render: (params, handle, actions) => (
        <Suspense fallback={<div className="stage-empty" role="status"><Spinner size="sm" label="Loading the server view" /></div>}>
          <ServerView params={params} handle={handle} actions={actions} parts={parts} />
        </Suspense>
      ),
      restore: isParams,
    }),
    context.registerRegion({ id: "servers.status", placement: "title-bar", order: 20, profiles: ["desktop", "web"], Component: createTitleChip(store) }),
    context.registerRegion({ id: "servers.compact-sheet", placement: "title-bar", profiles: ["compact"], Component: CompactSheetOffer }),
    context.registerCommand({
      id: "servers.open",
      label: "Server view",
      group: "Project",
      access: "read",
      run: async (actions) => {
        const cwd = actions.activeThread()?.cwd;
        if (!cwd) { actions.notify("Open a thread in a project first."); return; }
        await store.load(cwd, false);
        const status = store.get(cwd).status;
        const target = status ? worstTarget(status.targets) : undefined;
        if (!status || !target) { actions.notify("This project's .vscode/sftp.json names no server."); return; }
        openTarget(actions, status.workspace, target.targetId);
      },
    }),
    context.useService<TerminalRunService>(TERMINAL_RUN_SERVICE, (service) => {
      terminal = service;
      return () => { if (terminal === service) terminal = undefined; };
    }),
    context.useService<WorkspaceStoreSlice>(WORKSPACE_STORE_SERVICE, (service) => {
      workspace = service;
      let changes = service.getSnapshot().changes;
      const stops = [
        service.registerChangesSection(createChangesSection(store, () => workspace)),
        service.registerThreadRowAccessory(createRowMark(store)),
        service.registerRailSection?.(createRailSection(store, () => workspace)),
        // The Changes panel reread the disk: so may the local side of the status.
        service.subscribe(() => {
          const next = service.getSnapshot();
          if (next.changes === changes) return;
          changes = next.changes;
          if (next.cwd) store.refreshLoaded(next.cwd);
        }),
      ];
      return () => {
        for (const stop of stops) stop?.();
        if (workspace === service) workspace = undefined;
      };
    }),
    context.events.on("agent-status", (event) => { if (!event.running) store.refreshLoaded(undefined, true); }),
    // Drift is the drift service's; the status reads it again when that changes.
    context.host.onEvent(DRIFT_EVENT, () => store.refreshLoaded()),
    context.host.onEvent(DEPLOY_EVENT, () => store.refreshLoaded()),
  ];
  return () => {
    for (const dispose of disposers.reverse()) dispose();
    showSheet(false);
    store.dispose();
  };
}
