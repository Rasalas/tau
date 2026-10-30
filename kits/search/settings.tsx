import { useEffect, useState, useSyncExternalStore } from "react";
import { SettingRow, SettingsState, Switch, READ_ONLY_REASON, useHostCapabilities } from "tau";
import { indexStatusText, type MessageIndexFeed } from "./index-feed.js";

export function createSearchSettings(feed: MessageIndexFeed) {
  return function SearchSettings() {
    const status = useSyncExternalStore(feed.subscribe, feed.snapshot);
    const { readOnly } = useHostCapabilities();
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [failure, setFailure] = useState<{ reason: string; retry(): Promise<void> }>();
    useEffect(() => { if (feed.loaded) return; const timer = setTimeout(() => setLoading(true), 300); return () => clearTimeout(timer); }, []);
    const perform = async (action: () => Promise<void>) => {
      if (readOnly || busy) return;
      setBusy(true); setFailure(undefined);
      try { await action(); }
      catch (error) { setFailure({ reason: error instanceof Error ? error.message : String(error), retry: action }); }
      finally { setBusy(false); }
    };
    if (!feed.loaded) return loading ? <SettingsState kind="loading" title="Loading…" /> : null;
    const disabledReason = readOnly ? READ_ONLY_REASON : undefined;
    return <>
      <SettingRow id="setting-index-message-text" title="Index message text"
        description="Finds words anywhere in a thread's messages, including long and closed threads. The index stays on this machine and holds your messages and the agent's replies, not tool output or files."
        help="Turning this off deletes the index from this machine." disabledReason={disabledReason}
        control={<Switch label="Index message text" checked={status.enabled} disabled={readOnly || busy} onChange={enabled => { void perform(() => feed.configure(enabled)); }} />} />
      <SettingRow id="setting-message-index" title="Message index" description={indexStatusText(status)}
        help="Search keeps using the current index until the new one is ready." disabledReason={disabledReason}
        control={<button type="button" className="chrome-button" disabled={readOnly || busy || !status.enabled || status.state === "indexing"} onClick={() => { void perform(() => feed.rebuild()); }}>{status.state === "error" || status.state === "unavailable" ? "Retry" : "Rebuild index"}</button>} />
      {failure ? <SettingsState kind="error" title="Couldn't update the message index." description={failure.reason} action={<button type="button" className="chrome-button" disabled={readOnly || busy} onClick={() => { void perform(failure.retry); }}>Retry</button>} /> : null}
    </>;
  };
}
