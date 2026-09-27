import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BellRing, FileKey, Lock, Send, Smartphone, Trash2 } from "lucide-react";
import { Empty, SettingRow, SettingsSection, Skeleton, errorMessage, tooltipProps, useSetting } from "tau";
import type { DesktopExtension, DesktopExtensionContext, SettingsPageProps } from "tau";
import {
  DEFAULT_PUSH_CONTENT,
  PUSH_CONTENT_KEY,
  PUSH_EXTENSION_ID as ID,
  PUSH_STATE_EVENT,
  decodePushStatus,
  type PushContent,
  type PushDeviceRow,
  type PushStatus,
} from "./protocol.js";

const CONTENTS: Array<{ value: PushContent; label: string }> = [
  { value: "title", label: "Title only" },
  { value: "excerpt", label: "Title and excerpt" },
];
const CONTENT_LABELS = Object.fromEntries(CONTENTS.map((entry) => [entry.value, entry.label])) as Record<PushContent, string>;

/** The status Settings shows; the host's `state` event says when to ask again. */
class StatusStore {
  private snapshot: { status?: PushStatus; error?: string } = {};
  private readonly listeners = new Set<() => void>();

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  get = () => this.snapshot;

  set(status: PushStatus | undefined, error?: string): void {
    this.snapshot = { ...(status ?? this.snapshot.status ? { status: status ?? this.snapshot.status } : {}), ...(error ? { error } : {}) };
    for (const listener of this.listeners) listener();
  }
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** A file's text into a field: the key never leaves this page but to the host. */
function FilePick({ label, accept, onText }: { label: string; accept: string; onText(text: string): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="chrome-button" onClick={() => input.current?.click()}><FileKey size={13} aria-hidden="true" /> {label}</button>
    <input ref={input} type="file" accept={accept} hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void file.text().then(onText);
    }} />
  </>;
}

function ApnsForm({ context, onDone }: { context: DesktopExtensionContext; onDone(): void }) {
  const [keyId, setKeyId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [key, setKey] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await context.host.invoke("set-apns", { keyId, teamId, key });
      setKey("");
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="push-form">
      <div className="push-form-row">
        <label className="push-field"><span>Key ID</span><input className="settings-input" value={keyId} placeholder="ABC123DEFG" maxLength={10} spellCheck={false} onChange={(event) => setKeyId(event.target.value)} /></label>
        <label className="push-field"><span>Team ID</span><input className="settings-input" value={teamId} placeholder="DEF123GHIJ" maxLength={10} spellCheck={false} onChange={(event) => setTeamId(event.target.value)} /></label>
      </div>
      <label className="push-field">
        <span>Key (.p8)</span>
        <textarea className="settings-input push-key" value={key} rows={4} spellCheck={false} autoComplete="off" placeholder="-----BEGIN PRIVATE KEY-----" onChange={(event) => setKey(event.target.value)} />
      </label>
      {error ? <p className="push-error" role="alert">{error}</p> : null}
      <div className="push-form-actions">
        <FilePick label="Choose .p8 file…" accept=".p8,.pem,text/plain" onText={setKey} />
        <button type="button" className="primary" disabled={busy || !keyId.trim() || !teamId.trim() || !key.trim()} onClick={() => void save()}>{busy ? "Checking…" : "Save key"}</button>
      </div>
    </div>
  );
}

function FcmForm({ context, onDone }: { context: DesktopExtensionContext; onDone(): void }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await context.host.invoke("set-fcm", { serviceAccount: text });
      setText("");
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="push-form">
      <label className="push-field">
        <span>Service account (JSON)</span>
        <textarea className="settings-input push-key" value={text} rows={4} spellCheck={false} autoComplete="off" placeholder='{ "type": "service_account", "project_id": … }' onChange={(event) => setText(event.target.value)} />
      </label>
      {error ? <p className="push-error" role="alert">{error}</p> : null}
      <div className="push-form-actions">
        <FilePick label="Choose JSON file…" accept=".json,application/json" onText={setText} />
        <button type="button" className="primary" disabled={busy || !text.trim()} onClick={() => void save()}>{busy ? "Checking…" : "Save service account"}</button>
      </div>
    </div>
  );
}

/** One service: what is saved, or the form to save it. */
function KeySection({ title, description, saved, form, onForget }: {
  title: string;
  description: ReactNode;
  saved: ReactNode | undefined;
  form(done: () => void): ReactNode;
  onForget(): Promise<void>;
}) {
  const [replacing, setReplacing] = useState(false);
  const [busy, setBusy] = useState(false);
  const editing = !saved || replacing;
  return (
    <SettingsSection title={title}>
      <SettingRow
        title={saved ? "Saved" : "Not set up"}
        description={saved ?? description}
        control={saved ? <>
          <button type="button" className="chrome-button" onClick={() => setReplacing(!replacing)}>{replacing ? "Keep" : "Replace…"}</button>
          <button type="button" className="chrome-button danger" disabled={busy} onClick={() => { setBusy(true); void onForget().finally(() => setBusy(false)); }}>Remove</button>
        </> : undefined}
      />
      {editing ? form(() => setReplacing(false)) : null}
    </SettingsSection>
  );
}

function DeviceRow({ device, onTest, onRemove }: { device: PushDeviceRow; onTest(): Promise<void>; onRemove(): Promise<void> }) {
  const [busy, setBusy] = useState<"test" | "remove">();
  const run = (what: "test" | "remove", work: () => Promise<void>) => { setBusy(what); void work().finally(() => setBusy(undefined)); };
  const service = device.platform === "ios" ? "iPhone · Apple Push Notification service" : "Android · Firebase Cloud Messaging";
  const last = device.lastPush;
  return (
    <div className="connection-row push-device">
      <span className="push-device-icon" aria-label={service} {...tooltipProps(service)}><Smartphone size={15} aria-hidden="true" /></span>
      <div className="connection-row-text">
        <strong>{device.name}</strong>
        <small>
          Asked {when(device.registeredAt)}
          {last ? <> · {last.ok ? `last push ${when(last.at)}` : <span className="push-error">last push failed: {last.detail ?? "no reason given"}</span>}</> : null}
        </small>
      </div>
      <button type="button" className="icon-button bordered" aria-label={`Send a test push to ${device.name}`} disabled={busy !== undefined} {...tooltipProps("Send a test push")} onClick={() => run("test", onTest)}><Send size={13} /></button>
      <button type="button" className="icon-button bordered" aria-label={`Stop pushes to ${device.name}`} disabled={busy !== undefined} {...tooltipProps("Stop pushes to this device")} onClick={() => run("remove", onRemove)}><Trash2 size={13} /></button>
    </div>
  );
}

function createSettingsPage(context: DesktopExtensionContext, store: StatusStore) {
  return function PushSettingsPage({ onNotify }: SettingsPageProps) {
    const { status, error } = useSyncExternalStore(store.subscribe, store.get);
    const content = useSetting<PushContent>(`values.${ID}.${PUSH_CONTENT_KEY}`, {
      defaultValue: DEFAULT_PUSH_CONTENT,
      read: (raw) => (raw === "title" || raw === "excerpt" ? raw : undefined),
      format: (value) => CONTENT_LABELS[value],
      offline: (value) => context.preferences.setValue(ID, PUSH_CONTENT_KEY, value),
    });
    useEffect(() => {
      const refresh = () => context.host.invoke("status").then((next) => store.set(decodePushStatus(next)), (failure: unknown) => store.set(undefined, errorMessage(failure)));
      void refresh();
      return context.host.onEvent(PUSH_STATE_EVENT, () => void refresh());
    }, []);
    const act = (command: string, input: unknown) => context.host.invoke(command, input).then((next) => { store.set(decodePushStatus(next)); }, (failure: unknown) => onNotify(errorMessage(failure)));

    const header = <>
      <h3>Push</h3>
      <p className="lede">
        Your phone hears of a thread that finished, failed, asks you something or hands over to you while you are not at
        Tau. This machine sends the notifications itself, with your own Apple and Firebase keys; nothing goes through a
        relay. Pushes stay quiet while you use Tau on any screen.
      </p>
    </>;
    if (!status && error) return <div className="settings-page push-settings">{header}<Empty icon={<Lock size={18} />} title="Only this machine can set this up" description={error} /></div>;
    if (!status) return <div className="settings-page push-settings" aria-busy="true">{header}<Skeleton shape="card" /></div>;

    const forget = (service: "apns" | "fcm") => act("forget", { service });
    return (
      <div className="settings-page push-settings">
        {header}
        <SettingsSection title="What a notification says">
          <SettingRow
            id="setting-push-content"
            title="Content"
            description={content.value === "title"
              ? "The thread's title and what happened: finished, failed, your turn, a question."
              : "The thread's title and the first line of the agent's last message; the reason when it is your turn, the question when it asks."}
            setting={content}
            control={<div className="segmented" role="group" aria-label="Content">
              {CONTENTS.map((entry) => (
                <button key={entry.value} type="button" className={content.value === entry.value ? "active" : ""} aria-pressed={content.value === entry.value} onClick={() => content.set(entry.value)}>{entry.label}</button>
              ))}
            </div>}
          />
        </SettingsSection>
        <KeySection
          title="iPhone: Apple Push Notification service"
          description="An APNs key (.p8) from your Apple Developer account, its Key ID and your Team ID."
          saved={status.apns ? <>Key <code>{status.apns.keyId}</code> of team <code>{status.apns.teamId}</code>, saved {when(status.apns.savedAt)}</> : undefined}
          form={(done) => <ApnsForm context={context} onDone={done} />}
          onForget={() => forget("apns")}
        />
        <KeySection
          title="Android: Firebase Cloud Messaging"
          description="A service account of your Firebase project (Project settings → Service accounts → Generate new private key)."
          saved={status.fcm ? <>Project <code>{status.fcm.projectId}</code> as <code>{status.fcm.clientEmail}</code>, saved {when(status.fcm.savedAt)}</> : undefined}
          form={(done) => <FcmForm context={context} onDone={done} />}
          onForget={() => forget("fcm")}
        />
        <p className="settings-group-note push-warning">
          <Lock size={12} aria-hidden="true" /> The keys are kept in <code>{status.file}</code>, a file only your user account
          can read. They are not encrypted: the host runs without a window, often as a background service, where no
          keychain is at hand. Anyone who can read your files can send notifications to your phones with them.
        </p>
        <SettingsSection title="Devices" plain>
          {status.devices.length === 0
            ? <Empty size="compact" icon={<BellRing size={16} />} title="No phone has asked yet" description="Open this machine in the Tau app on your phone and allow notifications when it asks." />
            : status.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                onTest={async () => {
                  try {
                    const outcome = await context.host.invoke("test", { id: device.id }) as { ok: boolean; detail?: string };
                    onNotify(outcome.ok ? `Sent a test push to ${device.name}.` : `The test push to ${device.name} failed: ${outcome.detail ?? "no reason given"}.`);
                  } catch (failure) {
                    onNotify(errorMessage(failure));
                  }
                }}
                onRemove={() => act("remove-device", { id: device.id })}
              />
            ))}
        </SettingsSection>
      </div>
    );
  };
}

/**
 * Push's desktop half: Settings → Push, where the owner enters the APNs key
 * and the Firebase service account, picks what a notification says, and sees
 * the phones that asked for pushes.
 */
const push: DesktopExtension = {
  id: ID,
  name: "Push",
  activate(context) {
    const store = new StatusStore();
    return context.registerSettingsPage({ id: "push.settings", label: "Push", Icon: BellRing, group: "remote", order: 46, profiles: ["desktop", "web"], Component: createSettingsPage(context, store) });
  },
};

export default push;
