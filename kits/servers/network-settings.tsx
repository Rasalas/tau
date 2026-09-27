import { useCallback, useEffect, useState } from "react";
import { Badge, ListField, READ_ONLY_REASON, SettingRow, SettingsSection, Switch, errorMessage, useCommandAllowed } from "tau";
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
      .then((next) => { setState(decodeServerNetworkState(next)); if (done) onNotify(done); }, (failure: unknown) => { onNotify(errorMessage(failure)); })
      .finally(() => setBusy(false));
  }, [context, cwd, onNotify]);

  if (!state?.serverProject) return null;
  const disabled = busy || !allowed;
  return (
    <SettingsSection title="Network">
      <SettingRow
        id="setting-servers-network"
        title="Agent commands"
        description={state.allowAll
          ? "Reach the whole network, as in any other project. Tau no longer holds them to this machine."
          : "Reach this machine and the package sources only, so a live database or server stays out of reach."}
        {...(state.allowAll ? {} : { help: RUNTIME_ENFORCEMENT })}
        disabledReason={allowed ? undefined : READ_ONLY_REASON}
        control={<Switch
          label="Let agent commands reach the whole network"
          checked={state.allowAll}
          disabled={busy}
          onChange={(on) => change({ allowAll: on }, on ? "The agent's commands in this project reach the whole network now." : "The agent's commands reach only this machine and the allowed hosts again.")}
        />}
      />
      {state.pi && !state.pi.available && !state.allowAll ? <SettingRow
        title="Pi's sandbox"
        status={<Badge tone="warn" dot>Not available</Badge>}
        description={<>Not available here: {state.pi.reason ?? "unknown reason"}. Pi's commands in this project are refused until it is.</>}
      /> : null}
      <SettingRow
        id="setting-servers-allowed-hosts"
        title="Allowed hosts"
        description="Reachable besides the package sources. A name like *.example.com covers its subdomains."
        status={allowed ? undefined : READ_ONLY_REASON}
      >
        <ListField
          label="Allowed hosts"
          items={state.allowHosts}
          placeholder="api.example.com"
          empty="None besides the package sources. Add a host the project needs, such as a staging API."
          mono
          disabled={disabled}
          validate={(text) => (/\s|\//u.test(text) ? "Enter a host name alone, such as api.example.com." : undefined)}
          onChange={(allowHosts) => change({ allowHosts })}
        />
      </SettingRow>
      <SettingRow id="setting-servers-package-sources" title="Package sources" description="npm and Yarn, Packagist, GitHub, PyPI, RubyGems, crates.io, Go modules and JSR, always reachable.">
        <details className="servers-package-sources"><summary>Host names</summary><code>{state.packageSources.join(" · ")}</code></details>
      </SettingRow>
    </SettingsSection>
  );
}
