import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronRight, ExternalLink, Search } from "lucide-react";
import { LICENSES_FILE, unpackLicenses, type ThirdPartyLicense } from "../../shared/third-party-licenses";
import { useHostClient } from "../host-client-context";
import { usePlatform } from "../platform-context";
import { Empty, Skeleton } from "../components/ui/Feedback";
import { SettingRow, SettingsSection } from "./settings-layout";
import { settingAnchor } from "./settings-search";

type LicenseState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; packages: ThirdPartyLicense[] };

/** The manifest the build wrote beside the page; relative, so the file window, the web client and the dev server all find it. */
export async function loadLicenses(fetchImpl: typeof fetch = fetch, base: string = document.baseURI): Promise<ThirdPartyLicense[]> {
  const response = await fetchImpl(new URL(LICENSES_FILE, base).toString());
  if (!response.ok) throw new Error(`The list of licenses did not load (${response.status}).`);
  return unpackLicenses(await response.json());
}

const noSubscription = () => () => undefined;

/** Which Tau this is, where updates come from, and the licences of what it ships. */
export function AboutPage({ loader = loadLicenses }: { loader?: () => Promise<ThirdPartyLicense[]> }) {
  const client = useHostClient();
  const platform = usePlatform();
  useSyncExternalStore(client?.onVersions ?? noSubscription, () => JSON.stringify(client?.getVersions() ?? {}));
  const versions = client?.getVersions() ?? {};
  const [licenses, setLicenses] = useState<LicenseState>({ status: "loading" });
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string>();

  useEffect(() => {
    let live = true;
    loader().then(
      (packages) => { if (live) setLicenses({ status: "ready", packages }); },
      (error: unknown) => { if (live) setLicenses({ status: "error", message: error instanceof Error ? error.message : String(error) }); },
    );
    return () => { live = false; };
  }, [loader]);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => licenses.status !== "ready" ? [] : licenses.packages.filter((entry) =>
    !query || entry.name.toLowerCase().includes(query) || entry.license.toLowerCase().includes(query)), [licenses, query]);
  const skew = versions.window && versions.host && versions.window !== versions.host;

  return (
    <div className="settings-page">
      <SettingsSection title="Tau">
        <SettingRow
          title="Version"
          description={skew ? `This window runs ${versions.window}; the host it talks to runs ${versions.host}.` : "Tau is open source under the MIT licence."}
          control={<code className="about-version">{versions.window ?? versions.host ?? "unknown"}</code>}
        />
        {versions.window ? (
          <SettingRow
            title="Updates"
            description="An installed Tau checks for a new release every hour and after start; Settings → Defaults picks the track."
            control={<button type="button" className="chrome-button" onClick={() => { void client?.windowAction({ kind: "check-for-updates" }).catch(() => undefined); }}>Check for Updates…</button>}
          />
        ) : null}
      </SettingsSection>

      <SettingsSection title={licenses.status === "ready" ? `Open-source licenses (${licenses.packages.length})` : "Open-source licenses"} id={settingAnchor("Open-source licenses")}>
        <p className="settings-group-note">Tau is built on these packages. Each keeps its own licence; the notice it asks to be passed on opens under its name.</p>
        <label className="settings-filter about-licenses-filter">
          <Search size={14} />
          <input type="search" placeholder="Filter by package or licence…" aria-label="Filter licenses" value={filter} onChange={(event) => setFilter(event.target.value)} />
        </label>
        {licenses.status === "loading" ? (
          <div className="about-licenses-loading" aria-busy="true"><Skeleton /><Skeleton /><Skeleton /></div>
        ) : licenses.status === "error" ? (
          <Empty title="The licenses are not available" description={licenses.message} />
        ) : shown.length === 0 ? (
          <Empty title={`No package matches “${filter.trim()}”`} />
        ) : (
          <ul className="about-licenses" aria-label="Open-source licenses">
            {shown.map((entry) => {
              const key = `${entry.name}@${entry.version}`;
              const expanded = open === key;
              return (
                <li key={key}>
                  <div className="about-license-row">
                    <button type="button" className="about-license-toggle" aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : key)}>
                      <ChevronRight size={13} aria-hidden="true" />
                      <strong>{entry.name}</strong>
                      <code>{entry.version}</code>
                      <small>{entry.license}</small>
                    </button>
                    {entry.repository ? (
                      <button type="button" className="icon-button" aria-label={`Project source of ${entry.name}`} title="Project source" onClick={() => platform.openExternal(entry.repository!)}>
                        <ExternalLink size={12} />
                      </button>
                    ) : null}
                  </div>
                  {expanded ? <pre className="about-license-text">{entry.text ?? `${entry.name} ships no licence file; its package names ${entry.license}.`}</pre> : null}
                </li>
              );
            })}
          </ul>
        )}
      </SettingsSection>
    </div>
  );
}
