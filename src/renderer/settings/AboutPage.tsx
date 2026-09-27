import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { ChevronRight, ExternalLink, Search, X } from "lucide-react";
import { LICENSES_FILE, unpackLicenses, type ThirdPartyLicense } from "../../shared/third-party-licenses";
import { useHostClient } from "../host-client-context";
import { usePlatform } from "../platform-context";
import { tooltipProps } from "../components/ui/Tooltip";
import { errorMessage } from "../../workbench/error-message";
import { Button, HelpTip, SettingsState, ValueList, type ValueListItem } from "./controls";
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
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<string>();

  useEffect(() => {
    let live = true;
    setLicenses({ status: "loading" });
    loader().then(
      (packages) => { if (live) setLicenses({ status: "ready", packages }); },
      (error: unknown) => { if (live) setLicenses({ status: "error", message: errorMessage(error) }); },
    );
    return () => { live = false; };
  }, [loader, attempt]);

  const query = filter.trim().toLowerCase();
  const shown = useMemo(() => licenses.status !== "ready" ? [] : licenses.packages.filter((entry) =>
    !query || entry.name.toLowerCase().includes(query) || entry.license.toLowerCase().includes(query)), [licenses, query]);
  const skew = versions.window && versions.host && versions.window !== versions.host;
  const version = versions.window ?? versions.host;
  const facts: ValueListItem[] = skew
    ? [
      { label: "This window", value: versions.window!, mono: true, copy: versions.window! },
      { label: "Host", value: versions.host!, mono: true, copy: versions.host! },
    ]
    : [{ label: "Version", value: version ?? "Unknown", mono: Boolean(version), ...(version ? { copy: version } : {}) }];
  facts.push({ label: "Licence", value: "MIT, open source" });

  return (
    <div className="settings-page">
      <SettingsSection title="Tau" id={settingAnchor("Version")} plain>
        <ValueList label="Tau" items={facts} />
      </SettingsSection>

      {versions.window ? (
        <SettingsSection title="Updates">
          <SettingRow
            id={settingAnchor("Check for updates")}
            title="Check for updates"
            description="An installed Tau checks every hour and after start. The update track is on General."
            control={<Button onClick={() => { void client?.windowAction({ kind: "check-for-updates" }).catch(() => undefined); }}>Check now</Button>}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title={licenses.status === "ready" ? `Open-source licenses (${licenses.packages.length})` : "Open-source licenses"}
        id={settingAnchor("Open-source licenses")}
        headerAction={<HelpTip label="About the licenses" text="Tau is built on these packages. Each keeps its own licence; the notice it asks to be passed on opens under its name." />}
      >
        {licenses.status === "ready" && licenses.packages.length > 0 ? (
          <label className="settings-filter about-licenses-filter">
            <Search size={14} aria-hidden />
            <input type="search" placeholder="Filter by package or licence…" aria-label="Filter licenses" value={filter} onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Escape" && filter) { event.preventDefault(); event.stopPropagation(); setFilter(""); } }} />
            {filter ? <button type="button" className="tau-icon-button" aria-label="Clear the filter" onClick={() => setFilter("")}><X size={13} /></button> : null}
          </label>
        ) : null}
        {licenses.status === "loading" ? (
          <SettingsState kind="loading" title="Reading the licenses" rows={3} />
        ) : licenses.status === "error" ? (
          <SettingsState kind="error" title="The licenses are not available" description={licenses.message} onRetry={() => setAttempt((count) => count + 1)} />
        ) : licenses.packages.length === 0 ? (
          <SettingsState kind="empty" title="No licenses listed" description="The list this build carries names no package." />
        ) : shown.length === 0 ? (
          <SettingsState kind="empty" title={`No package matches “${filter.trim()}”`} description="Filter by a package's name or its licence." action={<Button onClick={() => setFilter("")}>Clear the filter</Button>} />
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
                      <button type="button" className="tau-icon-button" aria-label={`Project source of ${entry.name}`} {...tooltipProps("Project source")} onClick={() => platform.openExternal(entry.repository!)}>
                        <ExternalLink size={13} />
                      </button>
                    ) : <span className="about-license-no-source" aria-hidden />}
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
