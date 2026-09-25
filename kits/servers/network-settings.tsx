import { useCallback, useEffect, useState, type FormEvent } from "react";
import { AlertTriangle, X } from "lucide-react";
import { READ_ONLY_REASON, SettingRow, SettingsSection, errorMessage, useCommandAllowed } from "tau";
import type { DesktopExtensionContext } from "tau";
import { SERVERS_EXTENSION_ID, decodeServerNetworkState, type ServerNetworkState } from "./protocol.js";

/** What each runtime does in a limited project, in the order the runtime lists use. */
export const RUNTIME_ENFORCEMENT = "Pi runs them in a sandbox that reaches this machine and the allowed hosts; the Agent SDK runtime in the SDK's own sandbox with the same list; Codex in its sandbox without any network. OpenCode, Cursor, Grok and Antigravity cannot be held to it and do not run here. The terminal stays yours.";

/**
 * The network limit of a server project's agent (Settings → Servers): package
 * sources are allowed ahead, the user adds hosts or lifts the limit. Kept on
 * this machine, never in the project.
 */
export function NetworkSection({ context, cwd, onNotify }: { context: DesktopExtensionContext; cwd: string; onNotify(message: string): void }) {
  const [state, setState] = useState<ServerNetworkState>();
  const [host, setHost] = useState("");
  const [busy, setBusy] = useState(false);
  const allowed = useCommandAllowed(SERVERS_EXTENSION_ID, "set-network");

  useEffect(() => {
    let current = true;
    context.host.invoke("network", { cwd }).then((next) => { if (current) setState(decodeServerNetworkState(next)); }, () => undefined);
    return () => { current = false; };
  }, [context, cwd]);

  const change = useCallback((patch: { allowAll?: boolean; allowHosts?: string[] }, done?: string) => {
    setBusy(true);
    context.host.invoke("set-network", { cwd, ...patch })
      .then((next) => { setState(decodeServerNetworkState(next)); if (done) onNotify(done); return true; }, (failure: unknown) => { onNotify(errorMessage(failure)); return false; })
      .then((ok) => { if (ok && patch.allowHosts) setHost(""); })
      .finally(() => setBusy(false));
  }, [context, cwd, onNotify]);

  if (!state?.serverProject) return null;
  const disabled = busy || !allowed;
  const add = (event: FormEvent) => {
    event.preventDefault();
    const name = host.trim();
    if (name) change({ allowHosts: [...state.allowHosts, name] });
  };
  return (
    <SettingsSection title="Network">
      <SettingRow
        id="setting-servers-network"
        title="Agent commands"
        description={state.allowAll
          ? "Reach the whole network, as in any other project. Tau no longer holds them to this machine."
          : <>Reach this machine and the package sources only, so a live database or server stays out of reach. {RUNTIME_ENFORCEMENT}</>}
        disabledReason={allowed ? undefined : READ_ONLY_REASON}
        control={<button type="button" className="chrome-button" disabled={disabled}
          onClick={() => change({ allowAll: !state.allowAll }, state.allowAll ? "The agent's commands reach only this machine and the allowed hosts again." : "The agent's commands in this project reach the whole network now.")}>
          {state.allowAll ? "Limit again" : "Allow all"}
        </button>}
      />
      {state.pi && !state.pi.available && !state.allowAll ? <SettingRow
        title="Pi's sandbox"
        status={<AlertTriangle size={13} aria-hidden="true" />}
        description={<>Not available here: {state.pi.reason ?? "unknown reason"}. Pi's commands in this project are refused until it is.</>}
      /> : null}
      <SettingRow
        title="Allowed hosts"
        description={state.allowHosts.length ? "Reachable besides the package sources. A name like *.example.com covers its subdomains." : "None besides the package sources. Add a host the project needs, such as a staging API."}
        disabledReason={allowed ? undefined : READ_ONLY_REASON}
      >
        {state.allowHosts.length ? <ul className="servers-hosts">
          {state.allowHosts.map((name) => <li key={name}>
            <code>{name}</code>
            <button type="button" className="servers-host-remove" title={`Remove ${name}`} aria-label={`Remove ${name}`} disabled={disabled}
              onClick={() => change({ allowHosts: state.allowHosts.filter((entry) => entry !== name) })}><X size={13} aria-hidden="true" /></button>
          </li>)}
        </ul> : null}
        <form className="servers-host-add" onSubmit={add}>
          <input className="settings-input" value={host} disabled={disabled} placeholder="api.example.com" aria-label="Host to allow"
            spellCheck={false} autoCapitalize="off" autoCorrect="off" onChange={(event) => setHost(event.target.value)} />
          <button type="submit" className="chrome-button" disabled={disabled || !host.trim()}>Allow</button>
        </form>
      </SettingRow>
      <SettingRow title="Package sources" description="npm and Yarn, Packagist, GitHub, PyPI, RubyGems, crates.io, Go modules and JSR, always reachable.">
        <details className="servers-package-sources"><summary>Host names</summary><code>{state.packageSources.join(" · ")}</code></details>
      </SettingRow>
    </SettingsSection>
  );
}
