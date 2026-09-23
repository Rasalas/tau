import { useCallback, useEffect, useState } from "react";
import { SettingRow, SettingsSection, useSetting, type DesktopExtensionContext, type SettingHandle } from "tau";
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

function Toggle({ label, setting }: { label: string; setting: SettingHandle<boolean> }) {
  return (
    <button type="button" className={`switch ${setting.value ? "on" : ""}`} role="switch" aria-checked={setting.value} aria-label={label} disabled={!setting.writable} onClick={() => setting.set(!setting.value)}>
      <i />
    </button>
  );
}

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
    <button type="button" className={`snapshots-recorder${listening ? " listening" : ""}`} disabled={!setting.writable}
      aria-label={listening ? "Press the new shortcut, or Escape" : `Shortcut: ${formatAccelerator(setting.value, mac)}. Change`}
      onClick={() => { if (listening) stop(); else { suspend(true); setListening(true); } }} onBlur={() => { if (listening) stop(); }}>
      {listening ? "Press keys…" : <kbd>{formatAccelerator(setting.value, mac)}</kbd>}
    </button>
  );
}

const PERMISSION_TEXT: Record<Permission, string> = {
  "granted": "Allowed",
  "denied": "Not allowed",
  "not-determined": "Not asked yet",
  "restricted": "Blocked by the system",
  "unavailable": "Not available here",
};

function PermissionControl({ kind, state, host, refresh }: { kind: PermissionKind; state: Permission; host: HostApi; refresh: (next?: SnapShotAccess) => void }) {
  if (state === "granted" || state === "unavailable") return <span className={`snapshots-permission ${state}`}>{PERMISSION_TEXT[state]}</span>;
  return (
    <span className="snapshots-permission-actions">
      <span className={`snapshots-permission ${state}`}>{PERMISSION_TEXT[state]}</span>
      {state === "not-determined" || kind === "accessibility"
        ? <button type="button" className="text-button" onClick={() => void host("request-access", { kind }).then(refresh, () => refresh())}>Ask macOS</button>
        : null}
      <button type="button" className="text-button" onClick={() => void host("open-settings", { kind }).then(() => refresh(), () => refresh())}>Open System Settings</button>
    </span>
  );
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
          <p className="lede">SnapShots need macOS for now: they capture a window through macOS&apos;s Screen Recording and read it through its Accessibility.</p>
        </div>
      );
    }
    return (
      <div className="settings-page snapshots-settings">
        <h3>SnapShots</h3>
        <p className="lede">
          Press the shortcut in any app and Tau captures the window in front: its picture, the app and the window title and,
          if you allow it, the text and controls macOS reports for it. The SnapShot lands as a chip in the composer on screen.
        </p>
        <SettingsSection title="Shortcut">
          <SettingRow id="setting-snapshots-enabled" title="Capture with a global shortcut" description="Works while Tau runs, whichever app is in front. Off until you turn it on." setting={enabled}
            control={<Toggle label="Capture with a global shortcut" setting={enabled} />} />
          <SettingRow id="setting-snapshots-shortcut" title="Shortcut" description={conflict ?? "Click, then press the keys: a letter, digit or F-key with ⌘, ⌃ or ⌥."} status={shortcutStatus} setting={shortcut}
            control={<ShortcutRecorder setting={shortcut} suspend={suspend} />} />
          <SettingRow id="setting-snapshots-accessibility" title="Include what the window says" description="The accessibility tree: roles, labels and texts of the window's elements, with where they sit in the picture. Lets the agent read the window instead of guessing from pixels." setting={accessibility}
            control={<Toggle label="Include what the window says" setting={accessibility} />} />
        </SettingsSection>
        <SettingsSection title="macOS permissions">
          <SettingRow id="setting-snapshots-screen" title="Screen Recording" description="To capture the picture of one window. Tau never records a whole screen. After you allow it, macOS may ask you to restart Tau."
            control={access ? <PermissionControl kind="screen" state={access.screen} host={host} refresh={refresh} /> : null} />
          <SettingRow id="setting-snapshots-accessibility-permission" title="Accessibility" description="To know which window is in front and to read its text and controls. Tau only reads; it never clicks or types into other apps."
            control={access ? <PermissionControl kind="accessibility" state={access.accessibility} host={host} refresh={refresh} /> : null} />
        </SettingsSection>
        <SettingsSection title="Privacy">
          <p className="settings-note snapshots-privacy">
            A SnapShot holds only the window that was in front when you pressed the shortcut. Its text may include private
            things — messages, names, numbers — so look at the chip before you send it. It stays on this machine, in Tau&apos;s own
            folder, until you send or remove it (and at most a week); when you send it, the picture and the text go to the
            thread&apos;s model like any attachment.
          </p>
        </SettingsSection>
      </div>
    );
  };
}
