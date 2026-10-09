import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { BellRing, FileKey, Lock, Send } from "lucide-react";
import {
  Badge,
  Button,
  DangerAction,
  DangerZone,
  Empty,
  SegmentedControl,
  SettingRow,
  SettingsSection,
  SettingsState,
  TextField,
  ValueList,
  errorMessage,
  useSetting,
} from "tau";
import type { DesktopExtension, DesktopExtensionContext, SettingsPageProps } from "tau";
import {
  AWAY_MINUTES,
  DEFAULT_AWAY_MINUTES,
  DEFAULT_PUSH_CONTENT,
  PUSH_AWAY_KEY,
  PUSH_CONTENT_KEY,
  PUSH_EXTENSION_ID as ID,
  PUSH_STATE_EVENT,
  decodePushStatus,
  readAwayMinutes,
  type PushContent,
  type PushDeviceRow,
  type PushRoute,
  type PushStatus,
} from "./protocol.js";

const CONTENTS: Array<{ value: PushContent; label: string }> = [
  { value: "title", label: "Title only" },
  { value: "excerpt", label: "Title and excerpt" },
];
const AWAY_CHOICES = AWAY_MINUTES.map((minutes) => ({ value: String(minutes), label: `${minutes} min` }));
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
    <Button icon={<FileKey size={13} aria-hidden="true" />} onClick={() => input.current?.click()}>{label}</Button>
    <input ref={input} type="file" accept={accept} hidden onChange={(event) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (file) void file.text().then(onText);
    }} />
  </>;
}

/** Saves through the host; what is missing or refused shows at the form, and the draft stays. */
function useKeyForm(save: () => Promise<void>, missing: () => string | undefined, onDone: () => void) {
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const lacking = missing();
    if (lacking) { setError(lacking); return; }
    setBusy(true);
    setError(undefined);
    try {
      await save();
      onDone();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, submit: () => void submit() };
}

function ApnsForm({ context, onDone }: { context: DesktopExtensionContext; onDone(): void }) {
  const [keyId, setKeyId] = useState("");
  const [teamId, setTeamId] = useState("");
  const [key, setKey] = useState("");
  const form = useKeyForm(
    async () => { await context.host.invoke("set-apns", { keyId: keyId.trim(), teamId: teamId.trim(), key }); setKey(""); },
    () => (!keyId.trim() || !teamId.trim() || !key.trim() ? "Enter the Key ID, the Team ID and the key (.p8)." : undefined),
    onDone,
  );
  return (
    <div className="push-form">
      <div className="push-form-row">
        <label className="push-field"><span>Key ID</span><TextField label="Key ID" value={keyId} placeholder="ABC123DEFG" width="md" mono onCommit={setKeyId} /></label>
        <label className="push-field"><span>Team ID</span><TextField label="Team ID" value={teamId} placeholder="DEF123GHIJ" width="md" mono onCommit={setTeamId} /></label>
      </div>
      <label className="push-field">
        <span>Key (.p8)</span>
        <TextField label="Key (.p8)" value={key} rows={4} width="full" mono placeholder="-----BEGIN PRIVATE KEY-----" onCommit={setKey} />
      </label>
      {form.error ? <p className="push-error" role="alert">{form.error}</p> : null}
      <div className="push-form-actions">
        <FilePick label="Choose .p8 file…" accept=".p8,.pem,text/plain" onText={setKey} />
        <Button busy={form.busy} onClick={form.submit}>{form.busy ? "Checking…" : "Save key"}</Button>
      </div>
    </div>
  );
}

function FcmForm({ context, onDone }: { context: DesktopExtensionContext; onDone(): void }) {
  const [text, setText] = useState("");
  const form = useKeyForm(
    async () => { await context.host.invoke("set-fcm", { serviceAccount: text }); setText(""); },
    () => (text.trim() ? undefined : "Paste the service account's JSON, or choose its file."),
    onDone,
  );
  return (
    <div className="push-form">
      <label className="push-field">
        <span>Service account (JSON)</span>
        <TextField label="Service account (JSON)" value={text} rows={4} width="full" mono placeholder='{ "type": "service_account", "project_id": … }' onCommit={setText} />
      </label>
      {form.error ? <p className="push-error" role="alert">{form.error}</p> : null}
      <div className="push-form-actions">
        <FilePick label="Choose JSON file…" accept=".json,application/json" onText={setText} />
        <Button busy={form.busy} onClick={form.submit}>{form.busy ? "Checking…" : "Save service account"}</Button>
      </div>
    </div>
  );
}

/** One service: what is saved, or the form to save it. Removing it is in the danger zone. */
function KeySection({ title, id, row, description, saved, error, form }: {
  title: string;
  id: string;
  row: string;
  description: ReactNode;
  saved: ReactNode | undefined;
  /** The saved key does not read: this platform gets no pushes until it is replaced or removed. */
  error?: string;
  form(done: () => void): ReactNode;
}) {
  const [replacing, setReplacing] = useState(false);
  const editing = !saved || replacing;
  return (
    <SettingsSection title={title}>
      <SettingRow
        id={id}
        title={row}
        description={saved ? <>{saved}{error ? <><br /><span className="push-error" role="alert">This key does not read, so these phones get no pushes, not even through Tau's relay: {error}</span></> : null}</> : description}
        status={saved ? (error ? <Badge tone="danger" dot>Does not read</Badge> : <Badge tone="success" dot>Saved</Badge>) : <Badge>Not set up</Badge>}
        control={saved ? <Button onClick={() => setReplacing(!replacing)}>{replacing ? "Keep this one" : "Replace…"}</Button> : undefined}
      >
        {editing ? form(() => setReplacing(false)) : null}
      </SettingRow>
    </SettingsSection>
  );
}

const ROUTE_TEXT: Record<PushRoute, Record<"ios" | "android", string>> = {
  direct: { ios: "your APNs key", android: "your Firebase project" },
  relay: { ios: "Tau's relay", android: "Tau's relay" },
};

const UNREACHABLE: Record<PushRoute, string> = {
  relay: "Update the Tau app on this phone to get pushes through Tau's relay.",
  direct: "Open this machine in the Tau app on this phone once, so it hands over its token for your own key.",
};

function DeviceRow({ device, platformRoute = "relay", onTest, onRemove }: { device: PushDeviceRow; platformRoute?: PushRoute; onTest(): Promise<void>; onRemove(): Promise<void> }) {
  const [busy, setBusy] = useState<"test" | "remove">();
  const run = (what: "test" | "remove", work: () => Promise<void>) => { setBusy(what); void work().finally(() => setBusy(undefined)); };
  const last = device.lastPush;
  const relayed = device.route === "relay" || (device.route === "unreachable" && platformRoute === "relay");
  return (
    <SettingRow
      title={<>{device.name} <Badge>{`${device.platform === "ios" ? "iPhone" : "Android"} · ${relayed ? "relay" : device.platform === "ios" ? "APNs" : "FCM"}`}</Badge></>}
      description={<>
        {device.route === "unreachable" ? <><span className="push-error">{UNREACHABLE[platformRoute]}</span>{" "}</> : null}
        Asked {when(device.registeredAt)}
        {last ? <> · {last.ok ? `last push ${when(last.at)}` : <span className="push-error">last push failed: {last.detail ?? "no reason given"}</span>}</> : null}
      </>}
      control={<span className="push-device-actions">
        <Button icon={<Send size={13} />} busy={busy === "test"} disabled={busy !== undefined} aria-label={`Send a test push to ${device.name}`} onClick={() => run("test", onTest)}>Send test</Button>
        <Button variant="ghost" busy={busy === "remove"} disabled={busy !== undefined} aria-label={`Stop pushes to ${device.name}`} onClick={() => run("remove", onRemove)}>Stop pushes</Button>
      </span>}
    />
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
    // Kept as text, as every value in the host's config is.
    const away = useSetting<string>(`values.${ID}.${PUSH_AWAY_KEY}`, {
      defaultValue: String(DEFAULT_AWAY_MINUTES),
      read: (raw) => (raw === undefined ? undefined : String(readAwayMinutes(raw))),
      format: (value) => `${value} min`,
      offline: (value) => context.preferences.setValue(ID, PUSH_AWAY_KEY, value),
    });
    useEffect(() => {
      const refresh = () => context.host.invoke("status").then((next) => store.set(decodePushStatus(next)), (failure: unknown) => store.set(undefined, errorMessage(failure)));
      void refresh();
      return context.host.onEvent(PUSH_STATE_EVENT, () => void refresh());
    }, []);
    const act = (command: string, input: unknown) => context.host.invoke(command, input).then((next) => { store.set(decodePushStatus(next)); }, (failure: unknown) => onNotify(errorMessage(failure)));

    const header = <>
      <h3>Push</h3>
    </>;
    if (!status && error) return <div className="settings-page push-settings">{header}<Empty icon={<Lock size={18} />} title="Only this machine can set this up" description={error} /></div>;
    if (!status) return <div className="settings-page push-settings">{header}<SettingsState kind="loading" rows={3} title="Reading the push keys" /></div>;

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
            control={<SegmentedControl label="Content" value={content.value} options={CONTENTS} onChange={content.set} />}
          />
        </SettingsSection>
        <SettingsSection title="When your phone hears">
          <SettingRow
            id="setting-push-away"
            title="After you left Tau for"
            description="While you use Tau anywhere, it tells you there and your phone stays quiet. What you have not seen by the time you were away this long goes to your phone."
            setting={away}
            control={<SegmentedControl label="After you left Tau for" value={away.value} options={AWAY_CHOICES} onChange={away.set} />}
          />
        </SettingsSection>
        {status.routes ? (
          <SettingsSection title="How pushes travel">
            <SettingRow
              id="setting-push-route"
              title="Route"
              description={<>iPhone: {ROUTE_TEXT[status.routes.ios].ios}{status.apns?.error ? " (does not read)" : ""} · Android: {ROUTE_TEXT[status.routes.android].android}{status.fcm?.error ? " (does not read)" : ""}</>}
              help="A key of your own sends directly to Apple or Google. Without one, Tau's relay forwards the push, encrypted with a key only your phone and this machine have. Until the iPhone app can decrypt it, an iPhone shows 'A thread needs your attention'."
            />
          </SettingsSection>
        ) : null}
        <KeySection
          title="iPhone: Apple Push Notification service"
          id="setting-push-apns"
          row="APNs key"
          description="Optional: an APNs key (.p8) from your Apple Developer account, its Key ID and your Team ID. Without one, Tau's relay carries the pushes."
          saved={status.apns ? <>Key <code>{status.apns.keyId}</code> of team <code>{status.apns.teamId}</code>, saved {when(status.apns.savedAt)}</> : undefined}
          error={status.apns?.error}
          form={(done) => <ApnsForm context={context} onDone={done} />}
        />
        <KeySection
          title="Android: Firebase Cloud Messaging"
          id="setting-push-fcm"
          row="Service account"
          description="Optional: a service account of your Firebase project (Project settings → Service accounts → Generate new private key). Without one, Tau's relay carries the pushes."
          saved={status.fcm ? <>Project <code>{status.fcm.projectId}</code> as <code>{status.fcm.clientEmail}</code>, saved {when(status.fcm.savedAt)}</> : undefined}
          error={status.fcm?.error}
          form={(done) => <FcmForm context={context} onDone={done} />}
        />
        <SettingsSection title="Where the keys are kept">
          <SettingRow
            id="setting-push-key-file"
            title="Key file"
            description="Only your user account can read it, but it is not encrypted: anyone who can read your files can send notifications to your phones with these keys."
            help="The host runs without a window, often as a background service, where no keychain is at hand."
            status={<ValueList label="Key file" items={[{ label: "File", value: status.file, mono: true, copy: status.file }]} />}
          />
        </SettingsSection>
        <SettingsSection title="Devices" id="setting-push-devices">
          {status.devices.length === 0
            ? <SettingsState kind="empty" title="No phone has asked yet" description="Open this machine in the Tau app on your phone and allow notifications when it asks." />
            : status.devices.map((device) => (
              <DeviceRow
                key={device.id}
                device={device}
                platformRoute={status.routes?.[device.platform]}
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
        {status.apns || status.fcm ? (
          <DangerZone>
            {status.apns ? (
              <DangerAction
                title="Remove the APNs key"
                description="iPhones get their pushes through Tau's relay again. Apple lets you download a .p8 key only once."
                actionLabel="Remove key…"
                confirmTitle="Remove the APNs key?"
                confirmMessage={<>Tau deletes key {status.apns.keyId} from this machine; iPhones get their pushes through Tau's relay. To send directly again you need the .p8 file, which Apple offers for download only once.</>}
                onConfirm={() => void forget("apns")}
              />
            ) : null}
            {status.fcm ? (
              <DangerAction
                title="Remove the Firebase service account"
                description="Android phones get their pushes through Tau's relay again."
                actionLabel="Remove service account…"
                confirmTitle="Remove the Firebase service account?"
                confirmMessage={<>Tau deletes the service account of project {status.fcm.projectId} from this machine; Android phones get their pushes through Tau's relay. Firebase can generate a new private key for it.</>}
                onConfirm={() => void forget("fcm")}
              />
            ) : null}
          </DangerZone>
        ) : null}
      </div>
    );
  };
}

/** The rows the Settings search finds; each id is a row's on the page. */
export const PUSH_ROWS = [
  { id: "setting-push-content", label: "Content", keywords: ["notification text", "excerpt", "title only"] },
  { id: "setting-push-route", label: "Route", keywords: ["relay", "end-to-end", "encrypted", "direct"] },
  { id: "setting-push-apns", label: "APNs key", keywords: ["apple", "iphone", "ios", "p8", "key id", "team id"] },
  { id: "setting-push-fcm", label: "Service account", keywords: ["firebase", "android", "fcm", "json"] },
  { id: "setting-push-key-file", label: "Key file", keywords: ["encrypted", "keychain", "storage"] },
  { id: "setting-push-devices", label: "Devices", keywords: ["phones", "test push", "stop pushes"] },
];

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
    return context.registerSettingsPage({
      id: "push.settings",
      label: "Push",
      description: "Your phone hears of a thread that finished, failed or needs you while you are away from Tau: through Tau's relay, encrypted for your phone alone, or directly with keys of your own.",
      Icon: BellRing,
      group: "remote",
      order: 46,
      profiles: ["desktop", "web"],
      keywords: ["notifications", "phone", "apns", "firebase", "fcm", "relay"],
      rows: PUSH_ROWS,
      Component: createSettingsPage(context, store),
    });
  },
};

export default push;
