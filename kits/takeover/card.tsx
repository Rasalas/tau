import { useEffect, useState, useSyncExternalStore } from "react";
import { Hand, KeyRound, X } from "lucide-react";
import { errorMessage, tooltipProps, useHostCapabilities, type HostExtensionClient, type RegionProps, type WorkbenchActions } from "tau";
import { PREVIEW_PANEL, webUrl, type Takeover } from "./protocol.js";
import { services, takeovers, workbench } from "./store.js";

export interface TakeoverHosts {
  /** This kit's own host half. */
  own: HostExtensionClient;
  /** Preview Kit's host half, for the page in view. */
  preview: HostExtensionClient;
}

/**
 * The label of the one button that brings the target forward; none when there
 * is nothing to show. Away from the host's machine the Preview opens here
 * instead, where the user takes over by tapping and typing.
 */
export function jumpLabel(takeover: Takeover, app?: string, remote = false): string | undefined {
  switch (takeover.target.kind) {
    case "preview": return remote ? "Take over here" : "Show the page";
    case "window": return remote ? "Take over here" : app ? `Show ${app}` : "Show the app";
    case "browser": return "Open in browser";
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
    if (!state?.url) await preview.open(target.url, actions);
  }
  // A phone's Preview is a full sheet already; there is no stage to move it to.
  if (!remote) await enlargePreview(actions, takeover.id);
}

/** After Done or Cancel: the Preview goes back where it was, if this client staged it. */
export function putBack(takeoverId: string, actions: WorkbenchActions | undefined): void {
  if (!staged.delete(takeoverId)) return;
  if (actions && isStagedPreview(actions)) actions.togglePanelMaximized?.();
}

function hostOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try { return new URL(url).hostname || undefined; } catch { return undefined; }
}

/**
 * The two ways to a password the Preview cannot reach: type it into the page,
 * or sign in in the user's own browser and bring that site's cookies over.
 * Both only on a click; the import dialog's Import is the consent.
 */
function PasswordWays({ takeover, actions, hosts, remote }: { takeover: Takeover; actions: WorkbenchActions; hosts: TakeoverHosts; remote: boolean }) {
  const cookies = useSyncExternalStore(services.cookies.subscribe, services.cookies.get);
  const [pageUrl, setPageUrl] = useState(takeover.target.kind === "preview" ? takeover.target.url : undefined);
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (pageUrl) return;
    let live = true;
    void hosts.preview.invoke("state").then((state) => {
      const url = webUrl((state as { url?: unknown } | undefined)?.url);
      if (live && url) setPageUrl(url);
    }, () => undefined);
    return () => { live = false; };
  }, [hosts, pageUrl]);
  const site = hostOf(pageUrl);
  if (remote) {
    // The browser to import from and the one to open are on the host's machine, not on this device.
    return (
      <div className="takeover-passwords" role="group" aria-label="Your passwords">
        <p>
          Type the password into the Preview's field on this device: it goes to the page and is never recorded. This device's
          password manager can fill that field.
        </p>
      </div>
    );
  }
  const bringOver = () => {
    if (!cookies || !site) return;
    setBusy(true);
    setStatus(undefined);
    cookies.importSite({ site }).then((result) => {
      if (!result) setStatus("Nothing was imported.");
      else setStatus(`Imported ${String(result.imported)} ${result.imported === 1 ? "cookie" : "cookies"} into the Preview${result.reloaded ? "; the page reloaded" : ""}. Press Done when you are signed in.`);
    }, (error: unknown) => setStatus(errorMessage(error))).finally(() => setBusy(false));
  };
  return (
    <div className="takeover-passwords" role="group" aria-label="Your passwords">
      <p>
        The Preview cannot reach your password manager. Type or paste the password into the page — or sign in in your own
        browser, where your passwords are, and bring the session over.
      </p>
      {site ? (
        <div className="takeover-password-steps">
          <button type="button" className="takeover-button" onClick={() => actions.openExternal(pageUrl!)} {...tooltipProps(`Opens ${site} in your default browser`)}>
            Open in browser
          </button>
          {cookies ? (
            <button type="button" className="takeover-button" disabled={busy} onClick={bringOver} {...tooltipProps(`You pick the browser; only ${site}'s cookies are copied into the Preview`)}>
              {busy ? "Importing…" : "Bring the session over"}
            </button>
          ) : null}
        </div>
      ) : null}
      {status ? <p className="takeover-password-status" role="status">{status}</p> : null}
    </div>
  );
}

/** What the user takes over, as it looks now, on a device away from the host's machine; a tap opens it. */
function TakeoverFrame({ takeover, onOpen }: { takeover: Takeover; onOpen(): void }) {
  const preview = useSyncExternalStore(services.preview.subscribe, services.preview.get);
  const [picture, setPicture] = useState<{ url: string; width: number; height: number }>();
  const drivesWindow = takeover.target.kind === "window";
  useEffect(() => preview?.watch?.(drivesWindow ? { kind: "app", threadId: takeover.threadId } : { kind: "browser" }, 480, setPicture), [preview, drivesWindow, takeover.threadId]);
  if (!picture) return null;
  return (
    <button type="button" className="takeover-frame" onClick={onOpen} aria-label="Open what you take over" {...tooltipProps("Open it here to tap and type")}>
      <img src={picture.url} width={picture.width} height={picture.height} alt="" draggable={false} />
    </button>
  );
}

const READ_ONLY_REASON = "This device is paired Read only: answer on a device with Full access";

function TakeoverCard({ takeover, actions, hosts }: { takeover: Takeover; actions: WorkbenchActions; hosts: TakeoverHosts }) {
  const screen = useSyncExternalStore(services.screen.subscribe, services.screen.get);
  const preview = useSyncExternalStore(services.preview.subscribe, services.preview.get);
  const remote = preview?.remote?.() ?? false;
  const { readOnly } = useHostCapabilities();
  const [passwords, setPasswords] = useState(false);
  const [busy, setBusy] = useState(false);
  const [driven, setDriven] = useState<{ app?: string; title?: string }>();
  useEffect(() => {
    if (takeover.target.kind !== "window" || !screen) return;
    let live = true;
    void screen.load(takeover.threadId).then((state) => { if (live) setDriven(state?.window); }, () => undefined);
    return () => { live = false; };
  }, [screen, takeover]);
  const label = jumpLabel(takeover, driven?.app, remote);
  const showsFrame = remote && (takeover.target.kind === "preview" || takeover.target.kind === "window");
  const where = takeover.target.kind === "browser" ? takeover.target.url : driven?.title;
  const passwordsApply = takeover.target.kind === "preview";
  const finish = (command: "done" | "cancel") => {
    setBusy(true);
    putBack(takeover.id, actions);
    hosts.own.invoke(command, { id: takeover.id }).catch((error: unknown) => {
      setBusy(false);
      actions.notify(errorMessage(error));
    });
  };
  const jump = () => { jumpTo(takeover, actions, hosts).catch((error: unknown) => actions.notify(errorMessage(error))); };
  return (
    <section className="takeover-card" role="region" aria-label="Your turn">
      <div className="takeover-row">
        <Hand size={14} className="takeover-icon" aria-hidden="true" />
        <strong>Your turn</strong>
        <span className="takeover-reason" {...tooltipProps(takeover.reason, { when: "truncated" })}>{takeover.reason}</span>
        <span className="takeover-actions">
          {passwordsApply ? (
            <button
              type="button"
              className={`takeover-icon-button${passwords ? " active" : ""}`}
              aria-label="Your passwords"
              aria-expanded={passwords}
              onClick={() => setPasswords((open) => !open)}
              {...tooltipProps("Your passwords")}
            >
              <KeyRound size={14} aria-hidden="true" />
            </button>
          ) : null}
          {label ? (
            <button type="button" className="takeover-button" onClick={jump} {...(where ? tooltipProps(where, takeover.target.kind === "browser" ? { variant: "code" } : {}) : {})}>
              {label}
            </button>
          ) : null}
          <button type="button" className="takeover-button primary" disabled={busy || readOnly} onClick={() => finish("done")} {...tooltipProps(readOnly ? READ_ONLY_REASON : "Hand control back to the agent")}>
            Done
          </button>
          <button type="button" className="takeover-icon-button" aria-label="Cancel" disabled={busy || readOnly} onClick={() => finish("cancel")} {...tooltipProps(readOnly ? READ_ONLY_REASON : "Cancel: the agent stops")}>
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      {showsFrame ? <TakeoverFrame takeover={takeover} onOpen={jump} /> : null}
      {readOnly ? <p className="takeover-note">{READ_ONLY_REASON}.</p> : null}
      {passwords ? <PasswordWays takeover={takeover} actions={actions} hosts={hosts} remote={remote} /> : null}
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

/** The rail row's mark for a thread that waits for the user. */
export function TakeoverRowMark({ session }: { session: { id: string } }) {
  const list = useSyncExternalStore(takeovers.subscribe, takeovers.get);
  const takeover = list.find((entry) => entry.threadId === session.id);
  if (!takeover) return null;
  const label = `Your turn: ${takeover.reason}`;
  return (
    <span className="takeover-row-mark" role="img" aria-label={label} {...tooltipProps(label)}>
      <Hand size={12} aria-hidden="true" />
    </span>
  );
}
