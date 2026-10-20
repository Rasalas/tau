import { ArrowLeft, ExternalLink } from "lucide-react";
import { usePlatform } from "../platform-context";
import { useReleaseNotes, type NotesView } from "../use-release-notes";
import { useState } from "react";
import { isNightlyVersion } from "../../shared/app-version";

/** The same readable notes before installation, from About, and after a restart. */
export function UpdateNotes({ version, fromVersion, onBack }: { version: string; fromVersion?: string | undefined; onBack?(): void }) {
  const [attempt, setAttempt] = useState(0);
  const notes = useReleaseNotes(version, fromVersion, true, attempt);
  return <>
    <header className="update-center-head">
      {onBack ? <button type="button" className="update-icon" aria-label="Back to updates" onClick={onBack}><ArrowLeft size={14} /></button> : null}
      <div><h3>What's new</h3><p>{fromVersion && fromVersion !== version ? `${fromVersion} → ${version}` : version}</p></div>
    </header>
    <ReleaseNotesContent version={version} notes={notes} onRetry={() => setAttempt((value) => value + 1)} />
  </>;
}

/** Scrollable release groups, shared by the hover card and the full notes view. */
export function ReleaseNotesContent({ version, notes, onRetry, onOpen }: { version: string; notes: NotesView; onRetry(): void; onOpen?(url: string): void }) {
  const platform = usePlatform();
  const open = onOpen ?? platform.openExternal;
  const releaseUrl = (release: string) => `https://github.com/Rasalas/tau-releases/releases/tag/${isNightlyVersion(release) ? "nightly" : `v${release}`}`;
  return <div className="update-center-notes" aria-live="polite">
      {notes.state === "loading" ? <p aria-busy="true">Loading release notes…</p> : notes.state === "unavailable" ? <><p>Release notes are unavailable. You can still update Tau.</p><button type="button" className="update-quiet" onClick={onRetry}>Try again</button><button type="button" className="update-link" onClick={() => open(releaseUrl(version))}>Full changelog <ExternalLink size={12} /></button></> : notes.releases.map((release) => <section key={release.version}>
        {notes.releases.length > 1 ? <h4>{release.version}</h4> : null}
        <ul>{release.items.map((item, index) => <li key={`${index}:${item}`}>{item}</li>)}</ul>
        {release.totalItems > release.items.length ? <p>{release.totalItems - release.items.length} more changes in the full changelog</p> : null}
        <button type="button" className="update-link" onClick={() => open(release.url && /^https:\/\//u.test(release.url) ? release.url : releaseUrl(release.version))}>Full changelog <ExternalLink size={12} /></button>
      </section>)}
    </div>;
}
