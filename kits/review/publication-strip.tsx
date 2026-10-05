import { useEffect, useState } from "react";
import { GitCommitHorizontal } from "lucide-react";
import type { HostExtensionClient } from "tau";

interface Publication { commit: string; target: string; url?: string }

/** Rechecked after a turn and while visible; errors and thread switches hide stale proof. */
export function PublicationStrip({ host, threadId, streaming }: { host?: HostExtensionClient; threadId: string; streaming: boolean }) {
  const [read, setRead] = useState<{ threadId: string; value: Publication | null }>();
  useEffect(() => {
    if (!host || streaming) { setRead(undefined); return; }
    let live = true;
    let pending = false;
    const refresh = async () => {
      if (pending) return;
      pending = true;
      try {
        const value = await host.invoke("thread-publication", { threadId }) as Publication | null;
        if (live) setRead({ threadId, value });
      } catch { if (live) setRead(undefined); }
      finally { pending = false; }
    };
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 60_000);
    return () => { live = false; window.clearInterval(timer); };
  }, [host, threadId, streaming]);
  const publication = !streaming && read?.threadId === threadId ? read.value : undefined;
  if (!publication) return null;
  const content = <><GitCommitHorizontal size={14} aria-hidden /><span>On {publication.target}</span><code>{publication.commit.slice(0, 8)}</code></>;
  return <div className="review-pr-strip state-published" aria-label="Published commit">
    {publication.url ? <a className="review-pr-strip-open" href={publication.url} target="_blank" rel="noreferrer noopener" aria-label={`Open commit ${publication.commit.slice(0, 8)} on ${publication.target}`}>{content}</a>
      : <span className="review-pr-strip-open">{content}</span>}
  </div>;
}
