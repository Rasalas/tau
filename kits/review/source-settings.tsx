import { useCallback, useEffect, useState } from "react";
import { Plus, RefreshCw, X } from "lucide-react";
import { Badge, Button, errorMessage, Select, SettingRow, SettingsSection, SettingsState, TextField, type HostExtensionClient } from "tau";
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

function signIn(status: SourceProviderStatus): { text: string; tone: "success" | "warn" | "neutral" } {
  if (!status.installed) return { text: "Not installed", tone: "neutral" };
  if (status.signedIn) return { text: "Signed in", tone: "success" };
  return status.signedIn === false ? { text: "Not signed in", tone: "warn" } : { text: "Installed", tone: "neutral" };
}

function ProviderRow({ status }: { status: SourceProviderStatus }) {
  const missing = missingAbilities(PROVIDERS[status.service].capabilities);
  const summary = !status.installed
    ? status.hint
    : status.signedIn
      ? `Signed in${status.account ? ` as ${status.account}` : ""}.`
      : status.signedIn === false ? `Not signed in. ${status.hint ?? ""}` : status.hint ?? "Installed.";
  const badge = signIn(status);
  return (
    <SettingRow
      title={status.name}
      description={summary}
      help={`Tau reaches ${status.name} through ${status.tool}.`}
      status={missing.length > 0 ? `Left to the website: ${missing.join(", ")}.` : undefined}
      control={<Badge tone={badge.tone} dot>{badge.text}</Badge>}
    />
  );
}

/**
 * Settings → Review's source-control part, after T3 Code's list: which hosts
 * this machine can reach and as whom, and the provider of a self-hosted
 * server whose name does not say. Credentials stay with each provider's own
 * CLI or Git's credential helper; this page only reads whether they are there.
 */
export function SourceControlSettings({ host, onNotify }: { host: HostExtensionClient; onNotify(message: string): void }) {
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
    try {
      setHosts(await host.invoke("set-source-host", { host: name, service: kind }) as SourceHosts);
      if (kind) setServer("");
    } catch (reason) {
      onNotify(`${kind ? `${name} was not added` : `${name} was not forgotten`}: ${errorMessage(reason)}`);
    }
  };
  const add = () => {
    if (server.trim()) void choose(server.trim(), service);
    else onNotify("Enter the server's host name first, such as git.example.com.");
  };

  const entries = Object.entries(hosts).sort(([left], [right]) => left.localeCompare(right));

  return (
    <>
      <SettingsSection
        id="setting-review-git-hosts"
        title="Git hosts"
        headerAction={<Button variant="ghost" icon={<RefreshCw size={13} />} busy={loading} onClick={() => void refresh()}>Check again</Button>}
      >
        {error ? <SettingsState kind="error" title="The Git hosts could not be checked" description={error} onRetry={() => void refresh()} />
          : !statuses ? <SettingsState kind="loading" title="Checking the tools on this machine" rows={3} />
          : statuses.map((status) => <ProviderRow key={status.service} status={status} />)}
      </SettingsSection>
      <SettingsSection id="setting-review-servers" title="Self-hosted servers">
        {entries.map(([name, kind]) => (
          <SettingRow key={name} title={<code>{name}</code>} description={PROVIDERS[kind].name}
            control={<Button variant="ghost" icon={<X size={13} />} aria-label={`Forget ${name}`} onClick={() => void choose(name, null)}>Forget</Button>} />
        ))}
        <SettingRow
          title="Add a server"
          description="Tau reads a remote's host to choose its provider. When the name does not say, choose it here."
          help="A port counts when the remote has one: git.example.com:8443."
          control={<>
            <TextField label="Server" mono width="md" placeholder="git.example.com" value={server} onCommit={setServer} />
            <Select<RequestService> label="Provider" width="sm" value={service} options={REQUEST_SERVICES.map((kind) => ({ value: kind, label: PROVIDERS[kind].name }))} onChange={setService} />
            <Button icon={<Plus size={13} />} onClick={add}>Add</Button>
          </>}
        />
      </SettingsSection>
    </>
  );
}
