import { useEffect } from "react";
import type { StageTabHandle } from "tau";
import { terminalStore, useTerminalKit } from "./store.js";
import { TerminalView } from "./view.js";

/** What a terminal tab is opened and restored with: the host's own session id. */
export interface TerminalTabParams extends Record<string, unknown> {
  id: string;
  label: string;
}

export function terminalTabParams(params: Record<string, unknown>): TerminalTabParams {
  return { id: String(params.id ?? ""), label: String(params.label ?? "Terminal") };
}

/**
 * A terminal on the stage instead of in the dock. The shell itself lives in
 * the host, so this is only another view of it: it replays the scrollback by
 * byte offset like the panel's does, and closing the tab leaves the shell
 * running. While the tab is up the panel stands down, so one pty never has two
 * views fighting over its size.
 */
export function TerminalStageTab({ params, handle }: { params: TerminalTabParams; handle: StageTabHandle }) {
  const { sessions } = useTerminalKit();
  const session = sessions.find((entry) => entry.id === params.id);
  const label = session?.label ?? params.label;

  useEffect(() => {
    terminalStore.setOnStage(params.id, true);
    return () => terminalStore.setOnStage(params.id, false);
  }, [params.id]);

  useEffect(() => { handle.setTitle(label); }, [handle, label]);

  if (!session) {
    return <div className="stage-empty" role="status">This shell is gone. Close the tab or open a new terminal in the dock.</div>;
  }
  return <>
    <p className="terminal-status">
      <span>{session.cwd ?? session.label}</span>
      {session.exitCode !== undefined ? <span> · shell exited with {session.exitCode}</span> : null}
    </p>
    <div className="terminal-surface">
      <TerminalView
        key={session.id}
        id={session.id}
        cols={session.cols}
        rows={session.rows}
        {...(session.exitCode === undefined ? {} : { exitCode: session.exitCode })}
      />
    </div>
  </>;
}
