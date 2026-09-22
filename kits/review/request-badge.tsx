import { useEffect, useSyncExternalStore } from "react";
import type { UiSession } from "tau";
import { checksLabel, checksTone, requestShort, requestStateLabel, type RowRequests } from "./requests.js";

/** The request of a thread's checkout on its rail row: number, state and a checks dot. */
export function createRequestBadge(rows: RowRequests) {
  return function RequestBadge({ session }: { session: UiSession }) {
    const workspace = session.projectPath;
    // A row without a branch label is no Git checkout, or a detached one.
    const tracked = Boolean(session.projectLabel);
    useEffect(() => { if (tracked) rows.ensure(workspace); }, [tracked, workspace, session.projectLabel]);
    const request = useSyncExternalStore(rows.subscribe, () => rows.get(workspace));
    if (!tracked || !request) return null;
    const state = requestStateLabel(request);
    const checks = checksLabel(request.checks);
    const tone = checksTone(request.checks);
    const label = `${requestShort(request)} #${request.number}`;
    return (
      <span
        className={`request-badge state-${state}`}
        title={[`${label} · ${state}`, request.title, checks ? `checks: ${checks}` : ""].filter(Boolean).join("\n")}
        aria-label={`${label} ${state}${checks ? `, checks ${checks}` : ""}`}
      >
        {tone ? <i className={`request-checks-dot ${tone}`} aria-hidden="true" /> : null}
        {label}
      </span>
    );
  };
}
