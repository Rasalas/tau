import { useEffect, useRef, useState } from "react";
import type { UiMessage, UiTurnActivityEntry } from "../shared/contracts";
import type { UiEnvironmentThreadView } from "../shared/environments";
import type { PlatformEnvironments } from "../workbench/environments";
import { errorMessage } from "../workbench/error-message";

/** What the window knows of another machine's thread; undefined until it first answered. */
export function useEnvironmentThread(environments: PlatformEnvironments | undefined, machine: string, sessionId: string): UiEnvironmentThreadView | undefined {
  const [view, setView] = useState<UiEnvironmentThreadView>();
  useEffect(() => {
    setView(undefined);
    return environments?.watchThread?.(machine, sessionId, setView);
  }, [environments, machine, sessionId]);
  return view;
}

export interface EnvironmentTranscript {
  messages: UiMessage[];
  /** Each turn's tool runs, the running turn's too: what the stream has shown there so far. */
  activity: readonly UiTurnActivityEntry[];
  loaded: boolean;
  error?: string;
}

/**
 * The newest page of that thread, read again at every revision while the
 * machine answers. One read at a time: revisions that arrive during one are
 * folded into a single read after it, and a failed read keeps the messages.
 */
export function useEnvironmentTranscript(
  environments: PlatformEnvironments | undefined,
  view: UiEnvironmentThreadView | undefined,
): EnvironmentTranscript {
  const [state, setState] = useState<EnvironmentTranscript>({ messages: [], activity: [], loaded: false });
  const reading = useRef<{ key: string; busy: boolean; again: boolean }>({ key: "", busy: false, again: false });
  const machine = view?.machine;
  const sessionId = view?.sessionId;
  const ready = view?.status === "connected";
  const revision = view?.revision;

  useEffect(() => {
    const key = `${machine ?? ""}\n${sessionId ?? ""}`;
    if (reading.current.key !== key) {
      reading.current = { key, busy: false, again: false };
      setState({ messages: [], activity: [], loaded: false });
    }
  }, [machine, sessionId]);

  useEffect(() => {
    const load = environments?.transcriptPage;
    if (!load || !machine || !sessionId || !ready) return;
    const current = reading.current;
    if (current.busy) { current.again = true; return; }
    const read = (): void => {
      current.busy = true;
      current.again = false;
      load(machine, sessionId).then(
        (page) => { if (reading.current === current) setState({ messages: [...page.messages], activity: page.turnActivityHistory ?? [], loaded: true }); },
        (error: unknown) => { if (reading.current === current) setState((previous) => ({ ...previous, loaded: true, error: errorMessage(error) })); },
      ).finally(() => {
        current.busy = false;
        if (current.again && reading.current === current) read();
      });
    };
    read();
  }, [environments, machine, sessionId, ready, revision]);

  return state;
}
