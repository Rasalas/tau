import { useEffect, useSyncExternalStore } from "react";
import { AlertCircle, Camera } from "lucide-react";
import {
  hostHasLocalFiles,
  useWorkbenchShell,
  type ComposerChipDetailProps,
  type ComposerChipIcon,
  type ComposerInlineChip,
  type ComposerInlineContext,
  type ComposerInlineProps,
  type ComposerSendContribution,
  type DesktopExtension,
  type HostExtensionClient,
  type UiPromptImageAttachment,
  type WorkbenchActions,
} from "tau";
import { outline } from "./accessibility.js";
import { snapshotContext, snapshotLabel } from "./prompt.js";
import {
  SNAPSHOTS_EXTENSION_ID as ID,
  SNAPSHOT_EVENT,
  SNAPSHOT_FAILED_EVENT,
  type SnapShotContent,
  type SnapShotMeta,
  type SnapShotsHostCommands,
} from "./protocol.js";
import { createSnapShotsSettingsPage, SNAPSHOTS_SETTINGS_ROWS } from "./settings.js";
import { ShotStore, type Shot, type ShotContent } from "./shots.js";

type Commands = SnapShotsHostCommands;
export type HostApi = <K extends keyof Commands>(command: K, input: Commands[K]["input"]) => Promise<Commands[K]["output"]>;
const hostApi = (host: HostExtensionClient): HostApi => (command, input) => host.invoke(command, input) as never;

const isMeta = (value: unknown): value is SnapShotMeta => {
  const meta = value as Partial<SnapShotMeta> | null;
  return Boolean(meta && typeof meta.id === "string" && typeof meta.app === "string");
};

/** Reads a capture in full once and keeps it while its chip lives. */
export async function loadContent(store: ShotStore, host: HostApi, id: string): Promise<ShotContent | undefined> {
  const known = store.content(id);
  if (known) return known;
  const content = await host("read", { id }) as SnapShotContent | null;
  if (!content) return undefined;
  const loaded: ShotContent = {
    url: `data:${content.meta.mimeType};base64,${content.data}`,
    data: content.data,
    mimeType: content.meta.mimeType,
    ...(content.accessibility ? { accessibility: content.accessibility } : {}),
  };
  store.setContent(id, loaded);
  return loaded;
}

/** What the SnapShots of a draft add to its prompt; exported for the tests. */
export async function prepareSend(store: ShotStore, host: HostApi, context: ComposerInlineContext): Promise<ComposerSendContribution | undefined> {
  const shots = store.beginSend(context.scope);
  if (shots.length === 0) return undefined;
  const blocks: string[] = [];
  const attachments: UiPromptImageAttachment[] = [];
  for (const shot of shots) {
    const content = shot.meta && !shot.missing ? await loadContent(store, host, shot.id) : undefined;
    if (!shot.meta || !content) throw new Error("A SnapShot in this message is gone. Remove it and try again.");
    blocks.push(snapshotContext(shot.meta, content.accessibility, context.imageInput));
    if (context.imageInput) {
      const name = `snapshot-${shot.meta.app.replace(/[^\w.-]+/gu, "-").toLowerCase() || "window"}.${content.mimeType === "image/jpeg" ? "jpg" : "png"}`;
      attachments.push({ kind: "image", name, mimeType: content.mimeType, data: content.data, size: shot.meta.size });
    }
  }
  return { context: blocks.join("\n\n"), attachments };
}

function useShellActions(): WorkbenchActions | undefined {
  try {
    return useWorkbenchShell().actions;
  } catch {
    return undefined;
  }
}

/** The chip's icon: the capture's own picture once it is read, a camera until then. */
function thumbnail(store: ShotStore, host: HostApi, id: string): ComposerChipIcon {
  return function SnapShotThumbnail({ size = 14, className }) {
    const url = useSyncExternalStore(store.subscribe, () => store.content(id)?.url);
    useEffect(() => { void loadContent(store, host, id).catch(() => undefined); }, []);
    return url
      ? <img className={`snapshots-thumb${className ? ` ${className}` : ""}`} src={url} alt="" />
      : <Camera size={size} className={className} aria-hidden="true" />;
  };
}

export function SnapShotDetail({ store, host, chipId }: { store: ShotStore; host: HostApi } & ComposerChipDetailProps) {
  const shot = useSyncExternalStore(store.subscribe, () => store.find(chipId));
  const content = useSyncExternalStore(store.subscribe, () => store.content(chipId));
  useEffect(() => { void loadContent(store, host, chipId).catch(() => undefined); }, [chipId]);
  const meta = shot?.meta;
  if (!meta) return <div className="snapshots-detail"><p>This SnapShot is gone: it was sent, removed, or older than a week.</p></div>;
  const lines = content?.accessibility ? outline(content.accessibility.root, 30) : [];
  return (
    <div className="snapshots-detail">
      {content ? <img className="snapshots-detail-image" src={content.url} alt={`SnapShot of ${snapshotLabel(meta)}`} /> : <div className="snapshots-detail-image placeholder" />}
      <small className="snapshots-detail-meta">{new Date(meta.capturedAt).toLocaleString()} · {meta.width}×{meta.height}</small>
      {meta.accessibility ? (
        <details className="snapshots-detail-tree">
          <summary>{meta.accessibility.nodes} elements the window reported{meta.accessibility.truncated ? " (cut short)" : ""}</summary>
          <pre>{lines.join("\n")}{meta.accessibility.nodes > lines.length ? "\n…" : ""}</pre>
        </details>
      ) : <small className="snapshots-detail-note">{meta.accessibilityNote ?? "Picture only, no accessibility data."}</small>}
      <small className="snapshots-detail-note">Kept on this machine until you send it; then the picture and the window&apos;s text go to the thread&apos;s model.</small>
    </div>
  );
}

function chipOf(shot: Shot, icon: ComposerChipIcon, Detail: ComposerInlineChip["Detail"]): ComposerInlineChip {
  if (shot.missing) return { id: shot.id, label: "SnapShot", icon: AlertCircle, title: "This SnapShot is gone. Remove it.", state: "failed" };
  return {
    id: shot.id,
    label: shot.meta ? snapshotLabel(shot.meta) : "SnapShot",
    icon,
    ...(shot.meta ? {} : { state: "busy" as const }),
    ...(Detail ? { Detail } : {}),
  };
}

/**
 * SnapShots in the composer: a capture of one window, taken with the global
 * shortcut, lands as a chip in the composer on screen; its picture goes as an
 * image and its accessibility tree as data the model is told not to obey.
 */
const snapshots: DesktopExtension = {
  id: ID,
  name: "SnapShots",
  activate(context) {
    const store = new ShotStore();
    const host = hostApi(context.host);
    const icons = new Map<string, ComposerChipIcon>();
    const iconFor = (id: string) => icons.get(id) ?? icons.set(id, thumbnail(store, host, id)).get(id)!;
    let actions: WorkbenchActions | undefined;
    let disposed = false;

    const toastLanded = (meta: SnapShotMeta) => {
      actions?.toast?.({ id: `snapshots.${meta.id}`, type: "success", title: "SnapShot in the composer", description: snapshotLabel(meta) });
      if (document.hasFocus()) return;
      void context.attention?.notify({ title: "SnapShot taken", body: `${snapshotLabel(meta)} is in Tau's composer.`, tag: "tau.snapshots" });
    };

    // A capture goes to the first composer that asks for it; with none on screen it waits.
    // The host is asked for waiting ones only when some may wait: at start, after a
    // reconnect, or after an event found no composer. Not on every composer render.
    let mayWait = true;
    let delivering = Promise.resolve();
    const deliver = (ids: readonly string[]) => {
      delivering = delivering.then(async () => {
        for (const id of ids) {
          const scope = store.activeScope;
          if (!scope || disposed) {
            mayWait = true;
            return;
          }
          const meta = await host("claim", { id }).catch(() => null);
          if (!meta || store.activeScope !== scope) continue;
          store.add(scope, meta);
          toastLanded(meta);
        }
      });
    };
    const deliverPending = () => {
      if (!mayWait) return;
      mayWait = false;
      void host("pending", undefined).then((pending) => deliver(pending.map((meta) => meta.id))).catch(() => { mayWait = true; });
    };
    context.host.onEvent(SNAPSHOT_EVENT, (payload) => { if (isMeta(payload)) deliver([payload.id]); });
    context.host.onEvent(SNAPSHOT_FAILED_EVENT, (payload) => {
      const text = (payload as { message?: unknown } | undefined)?.message;
      actions?.toast?.({
        type: "error",
        title: "No SnapShot taken",
        description: typeof text === "string" ? text : "The window could not be captured.",
        actions: [{ label: "Settings", run: () => actions?.openSettings("snapshots.settings") }],
      });
    });

    let arming = false;
    const arm = () => {
      // The shortcut is the host machine's; a phone or another computer arming it would count as a change it made.
      if (!hostHasLocalFiles() || arming) return;
      arming = true;
      // The host arms from its own settings, and only a window that holds no shortcut yet.
      void host("armed", undefined).catch(() => null)
        .then((held) => (held ? undefined : host("arm", undefined)))
        .catch(() => undefined)
        .finally(() => { arming = false; });
    };
    context.events.on("host-connection", ({ state }) => {
      if (state !== "connected") return;
      arm();
      // An event sent while the socket was down may be lost.
      mayWait = true;
      if (store.activeScope) deliverPending();
    });
    arm();

    const Strip = ({ scope, draftState }: ComposerInlineProps) => {
      const shell = useShellActions();
      useEffect(() => { actions = shell ?? actions; }, [shell]);
      useEffect(() => {
        const ids = store.hydrate(scope, draftState.read(), draftState.write);
        if (ids.length > 0) {
          void host("meta", { ids }).then((answers) => store.resolve(new Map(ids.map((id, index) => [id, answers[index] ?? null])))).catch(() => undefined);
        }
        store.activeScope = scope;
        deliverPending();
        return () => { if (store.activeScope === scope) store.activeScope = undefined; };
      }, [draftState, scope]);
      return null;
    };
    const Detail = (props: ComposerChipDetailProps) => <SnapShotDetail store={store} host={host} {...props} />;

    context.registerComposerInline({
      id: "snapshots",
      profiles: ["desktop"],
      Component: Strip,
      chips: {
        list: (scope) => store.list(scope).map((shot) => chipOf(shot, iconFor(shot.id), Detail)),
        remove: (scope, id) => {
          if (store.remove(scope, id)) void host("release", { ids: [id] }).catch(() => undefined);
        },
      },
      subscribe: store.subscribe,
      prepareSend: (inline) => prepareSend(store, host, inline),
      settleSend: (scope, accepted) => {
        const sent = store.settle(scope, accepted);
        if (sent.length > 0) void host("release", { ids: sent.map((shot) => shot.id) }).catch(() => undefined);
      },
    });

    context.registerSettingsPage({
      id: "snapshots.settings",
      label: "SnapShots",
      description: "Capture the window in front from any app with a shortcut: its picture, title and, if you allow it, what it says. It lands as a chip in the composer.",
      group: "projects",
      Icon: Camera,
      order: 46,
      keywords: ["snapshot", "screenshot", "capture", "window", "accessibility", "shortcut", "screen recording"],
      rows: SNAPSHOTS_SETTINGS_ROWS,
      profiles: ["desktop"],
      Component: createSnapShotsSettingsPage(context, host, () => { void host("arm", undefined).catch(() => undefined); }),
    });

    return () => {
      disposed = true;
    };
  },
};

export default snapshots;
