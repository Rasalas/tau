import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Search } from "lucide-react";
import { Dialog, Spinner, errorMessage, type RegionProps } from "tau";
import {
  cookieImportFailure,
  type CookieImportFailure,
  type CookieImportResult,
  type CookieImportSite,
  type CookieImportSource,
  type PreviewHostClient,
} from "./protocol.js";
import { siteOf } from "./cookie-sites.js";

export interface CookieImportOpen {
  /** A site to select and filter to, e.g. the one the user just signed in to. */
  site?: string;
  /** The Preview profile to import into; the active one otherwise. */
  profile?: string;
}

interface OpenDialog extends CookieImportOpen {
  id: number;
  resolve(result: CookieImportResult | undefined): void;
}

/** Which import dialog is open; the service and the command open it, the title-bar layer draws it. */
export class CookieImportDialogs {
  private current: OpenDialog | undefined;
  private next = 0;
  private readonly listeners = new Set<() => void>();

  open(request: CookieImportOpen = {}): Promise<CookieImportResult | undefined> {
    this.current?.resolve(undefined);
    return new Promise((resolve) => this.set({ ...request, id: ++this.next, resolve }));
  }

  close(result?: CookieImportResult): void {
    const open = this.current;
    if (!open) return;
    this.set(undefined);
    open.resolve(result);
  }

  getSnapshot = (): OpenDialog | undefined => this.current;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private set(open: OpenDialog | undefined): void {
    this.current = open;
    for (const listener of [...this.listeners]) listener();
  }
}

/** The one dialog of this window: the panel's button, the command and the service share it. */
export const cookieImportDialogs = new CookieImportDialogs();

/** The reason a failure names, and its text without it. */
export function readFailure(error: unknown): { reason?: CookieImportFailure; text: string } {
  const message = errorMessage(error);
  const reason = cookieImportFailure(message);
  return { ...(reason ? { reason } : {}), text: message.replace(/^\[[a-z-]+\]\s*/u, "") };
}

/** Failures another attempt can clear: an answered prompt, a quit browser, a transient read. */
export const retryable = (reason: CookieImportFailure | undefined): boolean =>
  reason === "keychain-denied" || reason === "keychain-missing" || reason === "busy" || reason === "read-failed";

/** Sites matching a filter, the typed site's own first. */
export function filterSites(sites: readonly CookieImportSite[], query: string): CookieImportSite[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...sites];
  const exact = siteOf(needle);
  return sites.filter((entry) => entry.site.includes(needle) || entry.site === exact)
    .sort((a, b) => Number(b.site === exact) - Number(a.site === exact));
}

/** "github.com and google.com", "a, b, c and 4 more". */
export function formatSites(sites: readonly string[]): string {
  if (sites.length <= 1) return sites[0] ?? "";
  if (sites.length <= 3) return `${sites.slice(0, -1).join(", ")} and ${sites.at(-1)}`;
  return `${sites.slice(0, 3).join(", ")} and ${sites.length - 3} more`;
}

const cookies = (count: number): string => `${count.toLocaleString()} ${count === 1 ? "cookie" : "cookies"}`;
const SHOWN_SITES = 300;

type Phase =
  | { step: "choose" }
  | { step: "importing" }
  | { step: "done"; result: CookieImportResult }
  | { step: "failed"; reason?: CookieImportFailure; text: string };

/**
 * Browser import, with a site list: choose a browser and its
 * profile, the sites to bring over and the Preview profile they go into.
 * Nothing of a browser is read before the user names it, and nothing is
 * decrypted before Import.
 */
function CookieImportDialog({ request, client, onClose }: {
  request: OpenDialog;
  client: PreviewHostClient;
  onClose(result?: CookieImportResult): void;
}) {
  const [sources, setSources] = useState<CookieImportSource[]>();
  const [previewProfiles, setPreviewProfiles] = useState<string[]>([]);
  const [into, setInto] = useState(request.profile ?? "");
  const [sourceId, setSourceId] = useState("");
  const [profileId, setProfileId] = useState("");
  const [sites, setSites] = useState<CookieImportSite[]>();
  const [sitesProblem, setSitesProblem] = useState<{ reason?: CookieImportFailure; text: string }>();
  const [query, setQuery] = useState(request.site ?? "");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [phase, setPhase] = useState<Phase>({ step: "choose" });
  const [loadProblem, setLoadProblem] = useState("");
  const sitesRequest = useRef(0);

  useEffect(() => {
    void client["import-sources"]().then(setSources, (error: unknown) => { setSources([]); setLoadProblem(readFailure(error).text); });
    void client.profiles().then((profiles) => {
      setPreviewProfiles(profiles.profiles);
      setInto((current) => current && profiles.profiles.includes(current) ? current : profiles.active);
    }, () => undefined);
  }, [client]);

  const source = sources?.find((entry) => entry.id === sourceId);

  const loadSites = (id: string, profile: string) => {
    const token = ++sitesRequest.current;
    setSites(undefined);
    setSitesProblem(undefined);
    setSelected(new Set());
    if (!id || !profile) return;
    void client["import-sites"]({ source: id, profile }).then((listed) => {
      if (token !== sitesRequest.current) return;
      setSites(listed);
      const wanted = request.site ? siteOf(request.site) : "";
      if (wanted && listed.some((entry) => entry.site === wanted)) setSelected(new Set([wanted]));
    }, (error: unknown) => { if (token === sitesRequest.current) setSitesProblem(readFailure(error)); });
  };

  const chooseSource = (id: string) => {
    setSourceId(id);
    const first = sources?.find((entry) => entry.id === id)?.profiles[0]?.id ?? "";
    setProfileId(first);
    loadSites(id, first);
  };

  const shown = useMemo(() => filterSites(sites ?? [], query), [sites, query]);
  const toggle = (site: string) => setSelected((current) => {
    const next = new Set(current);
    if (next.has(site)) next.delete(site);
    else next.add(site);
    return next;
  });

  const runImport = () => {
    if (!source || selected.size === 0 || !into || phase.step === "importing") return;
    setPhase({ step: "importing" });
    void client["import-cookies"]({ source: source.id, profile: profileId, sites: [...selected], into })
      .then((result) => setPhase({ step: "done", result }), (error: unknown) => setPhase({ step: "failed", ...readFailure(error) }));
  };

  const close = () => {
    if (phase.step === "importing") return;
    onClose(phase.step === "done" ? phase.result : undefined);
  };

  const header = (title: string, text: string) => <header>
    <h2>{title}</h2>
    <p>{text}</p>
  </header>;

  if (phase.step === "importing") {
    return <Dialog className="confirm-dialog cookie-import-dialog" label="Importing cookies" onClose={close}>
      {header("Importing cookies", source?.keychain ? `Answer the keychain prompt for "${source.keychain}" if macOS shows one.` : "This takes a moment.")}
      <div className="cookie-import-wait"><Spinner size="sm" /> Importing {selected.size === 1 ? [...selected][0] : `${selected.size} sites`}…</div>
    </Dialog>;
  }

  if (phase.step === "done") {
    const { imported, skipped, skippedSites, profile, reloaded } = phase.result;
    return <Dialog className="confirm-dialog cookie-import-dialog" label="Cookies imported" onClose={close}>
      {header(
        imported > 0 ? `Imported ${cookies(imported)}` : skipped > 0 ? `Skipped ${cookies(skipped)}` : "No cookies to import",
        imported > 0
          ? `Added to the Preview profile “${profile}”.${reloaded ? " The page reloaded with them." : ""}${skipped > 0 ? ` ${cookies(skipped)} skipped.` : ""}`
          : "Nothing was added to the Preview profile.",
      )}
      {skippedSites.length > 0 ? <p className="cookie-import-note">Skipped: {formatSites(skippedSites)}. Cookies bound to another site or encrypted with a key Tau does not have stay behind.</p> : null}
      <footer><button className="primary" autoFocus onClick={close}>Done</button></footer>
    </Dialog>;
  }

  if (phase.step === "failed") {
    return <Dialog className="confirm-dialog cookie-import-dialog" label="Import failed" onClose={close}>
      {header(`Couldn’t import from ${source?.name ?? "the browser"}`, phase.text)}
      <footer>
        {phase.reason === "full-disk-access" ? <button onClick={() => void client["import-open-access"]().catch(() => undefined)}>Open System Settings</button> : null}
        <button onClick={close}>Close</button>
        {retryable(phase.reason) || phase.reason === "full-disk-access" ? <button className="primary" autoFocus onClick={runImport}>Try again</button> : null}
      </footer>
    </Dialog>;
  }

  return <Dialog className="confirm-dialog cookie-import-dialog" label="Import cookies from a browser" onClose={close}>
    {header("Import cookies from a browser", "Bring sign-ins from your own browser into a Preview profile. It is a one-time copy on this machine: later sign-ins and sign-outs stay separate.")}
    <div className="cookie-import-route">
      <label>
        <span>From</span>
        <select aria-label="Browser" autoFocus value={sourceId} disabled={!sources?.length} onChange={(event) => chooseSource(event.target.value)}>
          <option value="">{sources === undefined ? "Looking for browsers…" : sources.length ? "Choose a browser" : "No browser found"}</option>
          {sources?.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select>
        {source && source.profiles.length > 1 ? <select aria-label="Browser profile" value={profileId} onChange={(event) => { setProfileId(event.target.value); loadSites(sourceId, event.target.value); }}>
          {source.profiles.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}
        </select> : null}
      </label>
      <ArrowRight size={14} aria-hidden="true" />
      <label>
        <span>Into</span>
        <select aria-label="Preview profile" value={into} onChange={(event) => setInto(event.target.value)}>
          {previewProfiles.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
      </label>
    </div>
    {loadProblem ? <p className="cookie-import-problem" role="alert">{loadProblem}</p> : null}
    {sources?.length === 0 && !loadProblem ? <p className="cookie-import-note">Tau reads Chrome, Arc, Brave, Edge, Vivaldi, Chromium, Firefox and Safari, and found none of them here.</p> : null}
    {source ? <section className="cookie-import-sites" aria-label="Sites">
      <div className="cookie-import-filter">
        <Search size={12} aria-hidden="true" />
        <input aria-label="Filter sites" placeholder="Filter sites" spellCheck={false} value={query} onChange={(event) => setQuery(event.target.value)} />
        {shown.length > 0 ? <button type="button" className="text-button" onClick={() => setSelected((current) => new Set([...current, ...shown.slice(0, SHOWN_SITES).map((entry) => entry.site)]))}>select shown</button> : null}
        {selected.size > 0 ? <button type="button" className="text-button" onClick={() => setSelected(new Set())}>clear</button> : null}
      </div>
      {sitesProblem ? <div className="cookie-import-problem" role="alert">
        <span>{sitesProblem.text}</span>
        {sitesProblem.reason === "full-disk-access" ? <>
          <button type="button" className="text-button" onClick={() => void client["import-open-access"]().catch(() => undefined)}>Open System Settings</button>
          <button type="button" className="text-button" onClick={() => loadSites(sourceId, profileId)}>Check again</button>
        </> : <button type="button" className="text-button" onClick={() => loadSites(sourceId, profileId)}>Try again</button>}
      </div> : sites === undefined ? <div className="cookie-import-wait"><Spinner size="xs" /> Reading site names…</div>
        : shown.length === 0 ? <p className="cookie-import-note">{sites.length === 0 ? "This profile has no cookies." : `No site matches “${query.trim()}”.`}</p>
          : <ul className="cookie-import-list">
            {shown.slice(0, SHOWN_SITES).map((entry) => <li key={entry.site}>
              <label>
                <input type="checkbox" checked={selected.has(entry.site)} onChange={() => toggle(entry.site)} />
                <span className="cookie-import-site">{entry.site}</span>
                <small>{entry.cookies}</small>
              </label>
            </li>)}
            {shown.length > SHOWN_SITES ? <li className="cookie-import-more">{shown.length - SHOWN_SITES} more; filter to find them.</li> : null}
          </ul>}
    </section> : null}
    {source?.keychain ? <p className="cookie-import-note">
      {source.name} encrypts its cookies. On Import, macOS asks to hand “{source.keychain}” from your keychain to the system’s <code>security</code> tool. Choose Allow, not Always Allow: Always Allow would let any app read it through that tool.
    </p> : null}
    {source ? <p className="cookie-import-note">Quit {source.name} first so its newest sign-ins are on disk.</p> : null}
    <footer>
      <span className="cookie-import-count">{selected.size > 0 ? `${selected.size} ${selected.size === 1 ? "site" : "sites"} selected` : ""}</span>
      <button onClick={close}>Cancel</button>
      <button className="primary" disabled={!source || selected.size === 0 || !into} onClick={runImport}>Import</button>
    </footer>
  </Dialog>;
}

/** Drawn from a title-bar region, over the whole window, while the dialog is open. */
export function createCookieImportLayer(dialogs: CookieImportDialogs, client: PreviewHostClient) {
  return function CookieImportLayer(_props: RegionProps) {
    const open = useSyncExternalStore(dialogs.subscribe, dialogs.getSnapshot, dialogs.getSnapshot);
    if (!open) return null;
    return createPortal(<CookieImportDialog key={open.id} request={open} client={client} onClose={(result) => dialogs.close(result)} />, document.body);
  };
}
