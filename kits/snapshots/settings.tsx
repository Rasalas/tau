import { useCallback, useEffect, useState } from "react";
import { Badge, Button, SettingRow, SettingsSection, SettingsState, Switch, useSetting, type DesktopExtensionContext, type SettingHandle } from "tau";
import {
  DEFAULT_SHORTCUT,
  SETTING_ACCESSIBILITY,
  SETTING_ENABLED,
  SETTING_SHORTCUT,
  SHORTCUT_EVENT,
  SNAPSHOTS_EXTENSION_ID as ID,
  type Permission,
  type PermissionKind,
  type ShortcutState,
  type SnapShotAccess,
  type SnapShotsHostCommands,
} from "./protocol.js";
import { acceleratorFromKey, formatAccelerator, isAccelerator, shortcutConflict } from "./shortcut.js";

type HostApi = <K extends keyof SnapShotsHostCommands>(command: K, input: SnapShotsHostCommands[K]["input"]) => Promise<SnapShotsHostCommands[K]["output"]>;

const readBoolean = (raw: unknown) => (typeof raw === "boolean" ? raw : undefined);
const readAccelerator = (raw: unknown) => (isAccelerator(raw) ? raw : undefined);
const isMac = () => typeof navigator !== "undefined" && /Mac/u.test(navigator.platform);

/** The page's rows, for the Settings search. */
export const SNAPSHOTS_SETTINGS_ROWS = [
  { id: "setting-snapshots-enabled", label: "Capture with a global shortcut", keywords: ["shortcut", "hotkey", "capture", "window"] },
  { id: "setting-snapshots-shortcut", label: "Shortcut", keywords: ["hotkey", "keys", "chord", "record"] },
  { id: "setting-snapshots-accessibility", label: "Include what the window says", keywords: ["accessibility tree", "text", "controls"] },
  { id: "setting-snapshots-screen", label: "Screen Recording", keywords: ["permission", "macos", "privacy"] },
  { id: "setting-snapshots-accessibility-permission", label: "Accessibility", keywords: ["permission", "macos", "privacy"] },
];

/**
 * Records a chord from the next key press. While it listens, the global
 * shortcut is dropped, or pressing it would take a SnapShot instead.
 */
export function ShortcutRecorder({ setting, suspend }: { setting: SettingHandle<string>; suspend: (listening: boolean) => void }) {
  const [listening, setListening] = useState(false);
  const mac = isMac();
  const stop = useCallback(() => { setListening(false); suspend(false); }, [suspend]);
  useEffect(() => {
    if (!listening) return undefined;
    const onKey = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") return stop();
      const accelerator = acceleratorFromKey(event, mac);
      if (!accelerator) return;
      setting.set(accelerator);
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [listening, mac, setting, stop]);
  return (
    <Button className={`snapshots-recorder${listening ? " listening" : ""}`} disabled={!setting.writable}
      aria-label={listening ? "Press the new shortcut, or Escape" : `Shortcut: ${formatAccelerator(setting.value, mac)}. Change`}
      onClick={() => { if (listening) stop(); else { suspend(true); setListening(true); } }} onBlur={() => { if (listening) stop(); }}>
      {listening ? "Press keys…" : <kbd>{formatAccelerator(setting.value, mac)}</kbd>}
    </Button>
  );
}

const PERMISSION: Record<Permission, { text: string; tone: "success" | "warn" | "danger" | "neutral" }> = {
  "granted": { text: "Allowed", tone: "success" },
  "denied": { text: "Not allowed", tone: "danger" },
  "not-determined": { text: "Not asked yet", tone: "warn" },
  "restricted": { text: "Blocked by the system", tone: "danger" },
  "unavailable": { text: "Not available here", tone: "neutral" },
};

function PermissionControl({ kind, state, host, refresh }: { kind: PermissionKind; state: Permission; host: HostApi; refresh: (next?: SnapShotAccess) => void }) {
  const badge = <Badge tone={PERMISSION[state].tone} dot>{PERMISSION[state].text}</Badge>;
  if (state === "granted" || state === "unavailable") return badge;
  return <>
    {badge}
    {state === "not-determined" || kind === "accessibility"
      ? <Button onClick={() => void host("request-access", { kind }).then(refresh, () => refresh())}>Ask macOS</Button>
      : null}
    <Button onClick={() => void host("open-settings", { kind }).then(() => refresh(), () => refresh())}>Open System Settings</Button>
  </>;
}

/** Settings → SnapShots: the shortcut, the accessibility data, the two macOS permissions and what is kept where. */
export function createSnapShotsSettingsPage(context: DesktopExtensionContext, host: HostApi, rearm: () => void) {
  return function SnapShotsSettings() {
    const enabled = useSetting<boolean>(`options.${ID}.${SETTING_ENABLED}`, { defaultValue: false, read: readBoolean });
    const shortcut = useSetting<string>(`values.${ID}.${SETTING_SHORTCUT}`, { defaultValue: DEFAULT_SHORTCUT, read: readAccelerator, format: (value) => formatAccelerator(value, isMac()) });
    const accessibility = useSetting<boolean>(`options.${ID}.${SETTING_ACCESSIBILITY}`, { defaultValue: true, read: readBoolean });
    const [access, setAccess] = useState<SnapShotAccess | undefined>();
    const [state, setState] = useState<ShortcutState>({});

    const refresh = useCallback((next?: SnapShotAccess) => {
      if (next) setAccess(next);
      else void host("access", undefined).then(setAccess, () => setAccess({ supported: false, screen: "unavailable", accessibility: "unavailable" }));
    }, []);
    useEffect(() => {
      refresh();
      void host("shortcut-state", undefined).then(setState, () => undefined);
      const stop = context.host.onEvent(SHORTCUT_EVENT, (payload) => setState((payload ?? {}) as ShortcutState));
      // Coming back from System Settings is when a permission changes.
      const onFocus = () => refresh();
      window.addEventListener("focus", onFocus);
      return () => { stop(); window.removeEventListener("focus", onFocus); };
    }, [refresh]);

    const suspend = useCallback((listening: boolean) => {
      if (listening) void host("arm", { accelerator: null, accessibility: accessibility.value }).catch(() => undefined);
      else rearm();
    }, [accessibility.value]);

    const conflict = shortcutConflict(shortcut.value);
    const shortcutStatus = !enabled.value ? undefined : state.error ?? (state.registered ? `Registered: ${formatAccelerator(state.registered, isMac())}` : undefined);

    if (access && !access.supported) {
      return (
        <div className="settings-page snapshots-settings">
          <h3>SnapShots</h3>
          <SettingsState kind="empty" title="SnapShots need macOS" description="They capture a window through macOS's Screen Recording and read it through its Accessibility." />
        </div>
      );
    }
    return (
      <div className="settings-page snapshots-settings">
        <h3>SnapShots</h3>
        <SettingsSection title="Shortcut">
          <SettingRow id="setting-snapshots-enabled" title="Capture with a global shortcut" description="Works while Tau runs, whichever app is in front. Off until you turn it on." setting={enabled}
            control={<Switch label="Capture with a global shortcut" checked={enabled.value} onChange={enabled.set} />} />
          <SettingRow id="setting-snapshots-shortcut" title="Shortcut" description={conflict ?? "Click, then press the keys: a letter, digit or F-key with ⌘, ⌃ or ⌥."} status={shortcutStatus} setting={shortcut}
            control={<ShortcutRecorder setting={shortcut} suspend={suspend} />} />
          <SettingRow id="setting-snapshots-accessibility" title="Include what the window says" description="Lets the agent read the window instead of guessing from pixels."
            help="The accessibility tree: roles, labels and texts of the window's elements, with where they sit in the picture." setting={accessibility}
            control={<Switch label="Include what the window says" checked={accessibility.value} onChange={accessibility.set} />} />
        </SettingsSection>
        <SettingsSection title="macOS permissions">
          <SettingRow id="setting-snapshots-screen" title="Screen Recording" description="To capture the picture of one window. Tau never records a whole screen."
            help="After you allow it, macOS may ask you to restart Tau."
            control={access ? <PermissionControl kind="screen" state={access.screen} host={host} refresh={refresh} /> : null} />
          <SettingRow id="setting-snapshots-accessibility-permission" title="Accessibility" description="To know which window is in front and to read its text and controls. Tau only reads; it never clicks or types into other apps."
            control={access ? <PermissionControl kind="accessibility" state={access.accessibility} host={host} refresh={refresh} /> : null} />
        </SettingsSection>
        <SettingsSection title="Privacy">
          <SettingRow title="What a SnapShot holds" description="Only the window that was in front when you pressed the shortcut. Its text may include private things — messages, names, numbers — so look at the chip before you send it." />
          <SettingRow title="Where it stays" description="On this machine, in Tau's own folder, until you send or remove it, and at most a week. When you send it, the picture and the text go to the thread's model like any attachment." />
        </SettingsSection>
      </div>
    );
  };
}
