import { useEffect, useSyncExternalStore } from "react";
import type { UiSession } from "tau";
import { checksLabel, checksTone, requestShort, requestStateLabel, type RowRequests } from "./requests.js";
import { providerInfo } from "./protocol.js";
import type { ThreadLinkRows } from "./thread-links-store.js";

/**
 * The request of a thread's checkout on its rail row: number, state and a
 * checks dot, and how many more the thread links (T3 Code's "+N"). A thread
 * with links but no branch request shows its first link.
 */
export function createRequestBadge(rows: RowRequests, links: ThreadLinkRows) {
  return function RequestBadge({ session }: { session: UiSession }) {
    const workspace = session.projectPath;
    // A row without a branch label is no Git checkout, or a detached one.
    const tracked = Boolean(session.projectLabel);
    useEffect(() => { if (tracked) rows.ensure(workspace); }, [tracked, workspace, session.projectLabel]);
    useEffect(() => { links.ensure(session.id); }, [session.id]);
    const request = useSyncExternalStore(rows.subscribe, () => tracked ? rows.get(workspace) : undefined);
    const linked = useSyncExternalStore(links.subscribe, () => links.get(session.id));
    const others = request ? linked.filter((link) => link.url !== request.url) : linked.slice(1);
    const extra = others.length > 0 ? <span className="request-badge-more" title={others.map((link) => `#${link.number} ${link.title ?? link.repo}`).join("\n")}>+{others.length}</span> : null;
    if (!request) {
      const first = linked[0];
      if (!first) return null;
      const label = `${providerInfo(first.service).short} #${first.number}`;
      const state = first.state === "open" && first.draft ? "draft" : first.state ?? "open";
      return (
        <span className={`request-badge state-${state}`} title={[`${label} · ${state} · linked`, first.title ?? ""].filter(Boolean).join("\n")} aria-label={`${label} ${state}, linked${others.length ? `, ${others.length} more` : ""}`}>
          {label}{extra}
        </span>
      );
    }
    const state = requestStateLabel(request);
    const checks = checksLabel(request.checks);
    const tone = checksTone(request.checks);
    const label = `${requestShort(request)} #${request.number}`;
    return (
      <span
        className={`request-badge state-${state}`}
        title={[`${label} · ${state}`, request.title, checks ? `checks: ${checks}` : ""].filter(Boolean).join("\n")}
        aria-label={`${label} ${state}${checks ? `, checks ${checks}` : ""}${others.length ? `, ${others.length} more linked` : ""}`}
      >
        {tone ? <i className={`request-checks-dot ${tone}`} aria-hidden="true" /> : null}
        {label}{extra}
      </span>
    );
  };
}
