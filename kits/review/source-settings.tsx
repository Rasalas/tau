import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { errorMessage, SettingsSection, type HostExtensionClient } from "tau";
import { PROVIDERS, REQUEST_SERVICES, type ProviderCapabilities, type RequestService, type SourceHosts, type SourceProviderStatus } from "./protocol.js";

/** What a provider leaves to the website, in the words the settings row uses. */
export function missingAbilities(capabilities: ProviderCapabilities): string[] {
  const missing: string[] = [];
  if (!capabilities.files) missing.push("the diff");
  if (!capabilities.replies) missing.push("replies");
  if (!capabilities.resolve) missing.push("resolving conversations");
  if (!capabilities.reviewers) missing.push("reviewers");
  if (!capabilities.labels) missing.push("labels");
  if (!capabilities.merge.includes("rebase")) missing.push("rebase merges");
  if (!capabilities.reviewEvents.includes("request-changes")) missing.push("requesting changes");
  if (!capabilities.publish) missing.push("publishing");
  return missing;
}

type Tone = "ready" | "warn" | "off";

function tone(status: SourceProviderStatus): Tone {
  if (!status.installed) return "off";
  return status.signedIn === false ? "warn" : status.signedIn ? "ready" : "off";
}

function ProviderRow({ status }: { status: SourceProviderStatus }) {
  const missing = missingAbilities(PROVIDERS[status.service].capabilities);
  const summary = !status.installed
    ? status.hint
    : status.signedIn
      ? `Signed in${status.account ? ` as ${status.account}` : ""}.`
      : status.signedIn === false ? `Not signed in. ${status.hint ?? ""}` : status.hint ?? "Installed.";
  return (
    <li className="review-source-row" data-tone={tone(status)} aria-label={`${status.name}: ${summary}`}>
      <i className="review-source-dot" aria-hidden="true" />
      <div className="review-source-main">
        <span className="review-source-name"><strong>{status.name}</strong><small>{status.tool}</small></span>
        <span className="review-source-summary">{summary}</span>
        {missing.length > 0 ? <span className="review-source-missing">Left to the website: {missing.join(", ")}.</span> : null}
      </div>
    </li>
  );
}

/**
 * Settings → Review's source-control part, after T3 Code's list: which hosts
 * this machine can reach and as whom, and the provider of a self-hosted
 * server whose name does not say. Credentials stay with each provider's own
 * CLI or Git's credential helper; this page only reads whether they are there.
 */
export function SourceControlSettings({ host }: { host: HostExtensionClient }) {
  const [statuses, setStatuses] = useState<SourceProviderStatus[]>();
  const [hosts, setHosts] = useState<SourceHosts>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [server, setServer] = useState("");
  const [service, setService] = useState<RequestService>("forgejo");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const [nextStatuses, nextHosts] = await Promise.all([host.invoke("source-providers"), host.invoke("source-hosts")]);
      setStatuses(nextStatuses as SourceProviderStatus[]);
      setHosts(nextHosts as SourceHosts);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setLoading(false);
    }
  }, [host]);

  useEffect(() => { void refresh(); }, [refresh]);

  const choose = async (name: string, kind: RequestService | null) => {
    setError(undefined);
    try {
      setHosts(await host.invoke("set-source-host", { host: name, service: kind }) as SourceHosts);
      if (kind) setServer("");
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };

  const entries = Object.entries(hosts).sort(([left], [right]) => left.localeCompare(right));

  return (
    <>
      <SettingsSection
        title="Git hosts"
        headerAction={<button type="button" className="text-button" disabled={loading} onClick={() => void refresh()}>{loading ? "Checking…" : "Check again"}</button>}
      >
        {!statuses ? <p className="review-source-empty">{loading ? "Checking the tools on this machine…" : "Not checked yet."}</p> : (
          <ul className="review-source-list" aria-label="Git hosts">
            {statuses.map((status) => <ProviderRow key={status.service} status={status} />)}
          </ul>
        )}
      </SettingsSection>
      <SettingsSection title="Self-hosted servers">
        <p className="review-source-lede">
          Tau reads a remote's host to choose its provider. When the name does not say (git.example.com), choose it here; a port counts when the remote has one.
        </p>
        {entries.length > 0 ? (
          <ul className="review-source-hosts" aria-label="Self-hosted servers">
            {entries.map(([name, kind]) => (
              <li key={name}>
                <code>{name}</code>
                <span>{PROVIDERS[kind].name}</span>
                <button type="button" className="icon-button compact" aria-label={`Forget ${name}`} title="Forget this server" onClick={() => void choose(name, null)}><X size={11} /></button>
              </li>
            ))}
          </ul>
        ) : null}
        <form className="review-source-add" onSubmit={(event) => { event.preventDefault(); if (server.trim()) void choose(server, service); }}>
          <input type="text" className="settings-input" spellCheck={false} aria-label="Server" placeholder="git.example.com" value={server} onChange={(event) => setServer(event.target.value)} />
          <select className="settings-input" aria-label="Provider" value={service} onChange={(event) => setService(event.target.value as RequestService)}>
            {REQUEST_SERVICES.map((kind) => <option key={kind} value={kind}>{PROVIDERS[kind].name}</option>)}
          </select>
          <button type="submit" className="mini-button" disabled={!server.trim()}>Add</button>
        </form>
        {error ? <div className="settings-note" data-level="error" role="alert">{error}</div> : null}
      </SettingsSection>
    </>
  );
}
