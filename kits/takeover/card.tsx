import { useEffect, useState, useSyncExternalStore } from "react";
import { AppWindow, Check, Cookie, ExternalLink, Hand, Settings } from "lucide-react";
import { errorMessage, hostCommandAllowed, tooltipProps, useCommandAllowed, useHostName, type HostExtensionClient, type RegionProps, type ToolCardProps, type WorkbenchActions } from "tau";
import { PREVIEW_EXTENSION_ID, PREVIEW_PANEL, TAKEOVER_EXTENSION_ID, TAKEOVER_TIMEOUT_MS, webUrl, type Takeover } from "./protocol.js";
import { services, takeovers, workbench } from "./store.js";

export interface TakeoverHosts {
  /** This kit's own host half. */
  own: HostExtensionClient;
  /** Preview Kit's host half, for the page in view. */
  preview: HostExtensionClient;
}

/**
 * Programs that report the runtime they run in as their app: every Electron
 * app is "Electron", a Swing tool "java", a script "Python" or "node".
 */
const GENERIC_RUNTIMES = /^(?:electron(?: helper)?|java|javaw|jre|python(?:\d+(?:\.\d+)*)?w?|python launcher|node|nodejs|deno|bun|ruby|perl|php|mono|dotnet|wine(?:64)?|tclsh|wish)$/iu;

export function isGenericRuntime(app: string | undefined): boolean {
  return Boolean(app && GENERIC_RUNTIMES.test(app.trim()));
}

/** The jump button's tooltip for a driven window: the app's name, or the window's title where the app is only a runtime. */
export function windowTooltip(driven: { app?: string; title?: string } | undefined): string {
  const app = driven?.app?.trim();
  const title = driven?.title?.trim();
  if (app && !isGenericRuntime(app)) return `Show ${app}`;
  return title ? `Show “${title}”` : "Show the window the agent drives";
}

/**
 * The label of the one button that brings the target forward; none when there
 * is nothing to show or the Preview came forward by itself. Away from the
 * host's machine the Preview opens here instead, where the user takes over by
 * tapping and typing. A window's app is the button's icon and tooltip, never its text.
 */
export function jumpLabel(takeover: Takeover, remote = false, watchOnly = false): string | undefined {
  // A device that may not type follows along; it cannot take over.
  const here = watchOnly ? "Watch here" : "Take over here";
  switch (takeover.target.kind) {
    case "preview": return remote ? here : undefined;
    case "window": return remote ? here : "Show window";
    case "browser": return "Open in my browser";
    case "settings": return "Open settings";
    default: return undefined;
  }
}

const isStagedPreview = (actions: WorkbenchActions) => {
  const front = actions.activeStageTab?.();
  return front?.kind === "panel" && front.panelId === PREVIEW_PANEL;
};

// A timer, not a frame: an occluded window draws no frames, and the layout only needs one render.
const settle = () => new Promise<void>((resolve) => { setTimeout(resolve, 50); });

/** Takeovers whose Preview this client moved onto the stage, so Done can put it back. */
const staged = new Set<string>();
/** Takeovers whose page this client already brought forward once. */
const shown = new Set<string>();

/** The Preview on the stage beside the chat, large enough to sign in; the dock's toggle puts it back. */
async function enlargePreview(actions: WorkbenchActions, takeoverId: string): Promise<void> {
  if (!actions.togglePanelMaximized || isStagedPreview(actions)) return;
  // The panel opened just now; the layout knows it as the one in front only after it rendered.
  await settle();
  if (isStagedPreview(actions)) return;
  // Known as staged before the toggle, so a Done during the settle still puts it back.
  staged.add(takeoverId);
  actions.togglePanelMaximized();
  await settle();
  if (!staged.has(takeoverId) || isStagedPreview(actions)) return;
  staged.delete(takeoverId);
  if (actions.activeStageTab?.()?.kind === "panel") actions.togglePanelMaximized();
}

/** Brings forward exactly what the user takes over. */
export async function jumpTo(takeover: Takeover, actions: WorkbenchActions, hosts: TakeoverHosts): Promise<void> {
  const remote = services.preview.get()?.remote?.() ?? false;
  const { target } = takeover;
  if (target.kind === "settings") {
    actions.openSettings(target.page);
    return;
  }
  if (target.kind === "browser") {
    actions.openExternal(target.url);
    return;
  }
  if (target.kind === "window") {
    const preview = services.preview.get();
    if (preview) await preview.jump({ kind: "app", threadId: takeover.threadId }, actions);
    else {
      const screen = services.screen.get();
      if (!screen) throw new Error("Computer Use is off, so Tau cannot bring the app forward.");
      await screen.bringToFront(takeover.threadId);
    }
    return;
  }
  if (target.kind !== "preview") return;
  const preview = services.preview.get();
  if (!preview) throw new Error("The Preview is off.");
  await preview.jump({ kind: "browser" }, actions);
  if (target.url) {
    const state = await hosts.preview.invoke("state").catch(() => undefined) as { url?: string } | undefined;
    // A Read-only device looks at what is open; it cannot open the page itself.
    if (!state?.url && hostCommandAllowed(PREVIEW_EXTENSION_ID, "open")) await preview.open(target.url, actions);
  }
  // A phone's Preview is a full sheet already; there is no stage to move it to.
  if (!remote) await enlargePreview(actions, takeover.id);
}

/** After Done or Cancel: the Preview goes back where it was, if this client staged it. */
export function putBack(takeoverId: string, actions: WorkbenchActions | undefined): void {
  shown.delete(takeoverId);
  if (!staged.delete(takeoverId)) return;
  if (actions && isStagedPreview(actions)) actions.togglePanelMaximized?.();
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}

/** What the user takes over, as it looks now, on a device away from the host's machine; a tap opens it. */
function TakeoverFrame({ takeover, onOpen, watchOnly }: { takeover: Takeover; onOpen(): void; watchOnly: boolean }) {
  const preview = useSyncExternalStore(services.preview.subscribe, services.preview.get);
  const [picture, setPicture] = useState<{ url: string; width: number; height: number }>();
  const drivesWindow = takeover.target.kind === "window";
  useEffect(() => preview?.watch?.(drivesWindow ? { kind: "app", threadId: takeover.threadId } : { kind: "browser" }, 480, setPicture), [preview, drivesWindow, takeover.threadId]);
  if (!picture) return null;
  return (
    <button type="button" className="takeover-frame" onClick={onOpen} aria-label="Open what you take over" {...tooltipProps(watchOnly ? "Open it here to watch" : "Open it here to tap and type")}>
      <img src={picture.url} width={picture.width} height={picture.height} alt="" draggable={false} />
    </button>
  );
}

const READ_ONLY_REASON = "This device is paired Read only: answer on a device with Full access";

/** The one hand every "Your turn" draws; one element, so a memoized row stays put. */
export const HAND = <Hand size={11} aria-hidden="true" />;

/** Done and Cancel, from the card or from the phone's bar; `after` runs once the answer is on its way. */
function useFinish(takeover: Takeover, actions: WorkbenchActions, hosts: TakeoverHosts, after?: () => void) {
  const mayDone = useCommandAllowed(TAKEOVER_EXTENSION_ID, "done");
  const mayCancel = useCommandAllowed(TAKEOVER_EXTENSION_ID, "cancel");
  const [busy, setBusy] = useState(false);
  const finish = (command: "done" | "cancel") => {
    setBusy(true);
    putBack(takeover.id, actions);
    after?.();
    hosts.own.invoke(command, { id: takeover.id }).catch((error: unknown) => {
      setBusy(false);
      actions.notify(errorMessage(error));
    });
  };
  const buttons = <>
    <button type="button" className="takeover-link" disabled={busy || !mayCancel} onClick={() => finish("cancel")} {...tooltipProps(mayCancel ? "Cancel: the agent stops" : READ_ONLY_REASON)}>Cancel</button>
    <button type="button" className="takeover-done" disabled={busy || !mayDone} onClick={() => finish("done")} {...tooltipProps(mayDone ? "Hand control back to the agent" : READ_ONLY_REASON)}>
      <Check size={11} aria-hidden="true" />Done
    </button>
  </>;
  return { buttons, readOnly: !mayDone || !mayCancel };
}

/** The agent's words with the page's host in mono, as one sentence. */
function Reason({ text, host }: { text: string; host: string | undefined }) {
  const at = host ? text.indexOf(host) : -1;
  const end = /[.!?]$/u.test(text) ? "" : ".";
  return at < 0 || !host ? <>{text}{end}</> : <>{text.slice(0, at)}<code>{host}</code>{text.slice(at + host.length)}{end}</>;
}

function TakeoverCard({ takeover, actions, hosts }: { takeover: Takeover; actions: WorkbenchActions; hosts: TakeoverHosts }) {
  const screen = useSyncExternalStore(services.screen.subscribe, services.screen.get);
  const preview = useSyncExternalStore(services.preview.subscribe, services.preview.get);
  const cookies = useSyncExternalStore(services.cookies.subscribe, services.cookies.get);
  const remote = preview?.remote?.() ?? false;
  // Passwords are typed into the page; a device that may not type has no use for the ways to them.
  const mayType = useCommandAllowed(PREVIEW_EXTENSION_ID, "input");
  const { buttons, readOnly } = useFinish(takeover, actions, hosts);
  const { target } = takeover;
  const [driven, setDriven] = useState<{ app?: string; title?: string }>();
  const [appIcon, setAppIcon] = useState<string | null>(null);
  const [pageUrl, setPageUrl] = useState(target.kind === "preview" ? target.url : undefined);
  const [status, setStatus] = useState<string>();
  const [importing, setImporting] = useState(false);
  const jump = () => { jumpTo(takeover, actions, hosts).catch((error: unknown) => actions.notify(errorMessage(error))); };
  useEffect(() => {
    if (target.kind !== "window" || !screen) return;
    let live = true;
    void screen.load(takeover.threadId).then((state) => {
      if (!live) return;
      setDriven(state?.window);
      // A runtime's icon (Electron's, Java's) would name the wrong app, and an unnamed app may be one.
      const app = state?.window?.app;
      if (app && !isGenericRuntime(app)) void screen.icon?.(takeover.threadId).then((url) => { if (live) setAppIcon(url); }, () => undefined);
    }, () => undefined);
    return () => { live = false; };
  }, [screen, takeover, target.kind]);
  useEffect(() => {
    if (target.kind !== "preview" || pageUrl) return;
    let live = true;
    void hosts.preview.invoke("state").then((state) => {
      const url = webUrl((state as { url?: unknown } | undefined)?.url);
      if (live && url) setPageUrl(url);
    }, () => undefined);
    return () => { live = false; };
  }, [hosts, pageUrl, target.kind]);
  // On the host's machine the page comes forward once, without a click (design 3d).
  useEffect(() => {
    if (target.kind !== "preview" || remote || !preview || shown.has(takeover.id)) return;
    shown.add(takeover.id);
    jump();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- once per takeover
  }, [preview, remote, takeover.id, target.kind]);
  const label = jumpLabel(takeover, remote, !mayType);
  const showsFrame = remote && (target.kind === "preview" || target.kind === "window");
  const where = target.kind === "browser" ? target.url : target.kind === "window" ? windowTooltip(driven) : undefined;
  const site = target.kind === "preview" && !remote && mayType ? hostOf(pageUrl) : undefined;
  const bringOver = () => {
    if (!cookies || !site) return;
    setImporting(true);
    setStatus(undefined);
    cookies.importSite({ site }).then((result) => {
      if (!result) setStatus("Nothing was imported.");
      else setStatus(`Imported ${String(result.imported)} ${result.imported === 1 ? "cookie" : "cookies"} into the Preview${result.reloaded ? "; the page reloaded" : ""}. Press Done when you are signed in.`);
    }, (error: unknown) => setStatus(errorMessage(error))).finally(() => setImporting(false));
  };
  return (
    <section className="takeover-card" role="region" aria-label="Your turn">
      <header><Hand size={12} aria-hidden="true" />Your turn<span>{`waits up to ${String(TAKEOVER_TIMEOUT_MS / 60_000)} min`}</span></header>
      <p><Reason text={takeover.reason} host={hostOf(target.kind === "preview" || target.kind === "browser" ? pageUrl ?? target.url : undefined)} /> The agent's preview and computer-use calls are held until you press Done.</p>
      {showsFrame ? <TakeoverFrame takeover={takeover} onOpen={jump} watchOnly={!mayType} /> : null}
      {readOnly ? <p className="takeover-note">{READ_ONLY_REASON}.</p> : null}
      <div className="takeover-actions">
        {site && cookies ? (
          <button type="button" className="takeover-link" disabled={importing} onClick={bringOver} {...tooltipProps(`You pick the browser; only ${site}'s cookies are copied into the Preview`)}>
            <Cookie size={11} aria-hidden="true" />{importing ? "Importing…" : "Bring my browser session over"}
          </button>
        ) : null}
        {site ? (
          <button type="button" className="takeover-link" onClick={() => actions.openExternal(pageUrl!)} {...tooltipProps(`Opens ${site} in your default browser, where your passwords are`)}>
            <ExternalLink size={11} aria-hidden="true" />Open in my browser
          </button>
        ) : null}
        {label ? (
          <button type="button" className="takeover-link" onClick={jump} {...(where ? tooltipProps(where, target.kind === "browser" ? { variant: "code" } : {}) : {})}>
            {target.kind === "window"
              ? appIcon ? <img className="takeover-app-icon" src={appIcon} alt="" draggable={false} /> : <AppWindow size={11} aria-hidden="true" />
              : target.kind === "browser" ? <ExternalLink size={11} aria-hidden="true" /> : target.kind === "settings" ? <Settings size={11} aria-hidden="true" /> : null}
            {label}
          </button>
        ) : null}
        <span className="takeover-spacer" />
        {buttons}
      </div>
      {status ? <p className="takeover-note" role="status">{status}</p> : null}
    </section>
  );
}

/** Above the composer of a thread that waits for the user. */
export function createTakeoverRegion(hosts: TakeoverHosts) {
  return function TakeoverRegion({ snapshot, actions }: RegionProps) {
    useEffect(() => { workbench.set(actions); }, [actions]);
    const list = useSyncExternalStore(takeovers.subscribe, takeovers.get);
    const takeover = snapshot?.sessionId ? list.find((entry) => entry.threadId === snapshot.sessionId) : undefined;
    return takeover ? <TakeoverCard key={takeover.id} takeover={takeover} actions={actions} hosts={hosts} /> : null;
  };
}

/** The first takeover of the page or a window: what the Preview's frame stands for. */
export const heldTakeover = (list: readonly Takeover[]) => list.find((entry) => entry.target.kind === "preview" || entry.target.kind === "window");

/** Over a phone's Preview while the user holds it: whose turn, and the way back (design 3f). */
export function createTakeoverBar(hosts: TakeoverHosts) {
  function Bar({ takeover, actions }: { takeover: Takeover; actions: WorkbenchActions }) {
    const { buttons } = useFinish(takeover, actions, hosts, () => actions.closePanel?.(PREVIEW_PANEL));
    return (
      <div className="takeover-bar" role="region" aria-label="Your turn">
        <Hand size={16} aria-hidden="true" />
        <span {...tooltipProps(takeover.reason, { when: "truncated" })}>Your turn · {takeover.reason}</span>
        {buttons}
      </div>
    );
  }
  return function TakeoverBar({ actions }: { actions: WorkbenchActions }) {
    const takeover = heldTakeover(useSyncExternalStore(takeovers.subscribe, takeovers.get));
    return takeover ? <Bar key={takeover.id} takeover={takeover} actions={actions} /> : null;
  };
}

export function TakeoverFooter() {
  const machine = useHostName();
  return <p className="takeover-footer">This page runs on {machine ?? "your computer"} and streams to your phone. Evidence is paused while you type.</p>;
}

const ENDED: ReadonlyArray<[RegExp, string]> = [
  [/^The user is done/u, "You handed control back"],
  [/^The user cancelled/u, "You cancelled the takeover"],
  [/^Nobody took over/u, "Nobody took over within 30 min"],
];

/** The transcript's line for `request_takeover`: waiting for the user, then how it ended. */
export function TakeoverLine({ tools }: ToolCardProps) {
  return <>{tools.map((tool) => {
    const running = tool.status === "running";
    const output = tool.output?.trim() ?? "";
    return (
      <div key={tool.id} className="work-live takeover-line">
        <div className="work-live-line">
          {running ? <span className="spinner tone-current small" aria-hidden="true" /> : HAND}
          <span className="work-live-label">
            {running ? "Waiting for you · evidence paused" : ENDED.find(([pattern]) => pattern.test(output))?.[1] ?? (output.split("\n")[0] || "The takeover ended")}
          </span>
        </div>
      </div>
    );
  })}</>;
}
