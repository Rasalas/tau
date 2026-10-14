import { errorMessage, type HostExtensionClient } from "tau";
import { CUSTOMIZE_CHANGED_EVENT, CUSTOMIZE_COMMANDS, EMPTY_STATE, type CustomizeState } from "./protocol.js";

export type CustomizeEdit = (state: CustomizeState) => CustomizeState;

/**
 * The machine's customizations as this client knows them: read once, followed
 * through the host's `changed` event, written whole. A write shows at once and
 * is taken back when the host refuses it.
 */
export function createCustomizeStore(host: HostExtensionClient) {
  let state: CustomizeState = EMPTY_STATE;
  let loaded = false;
  let writing: Promise<unknown> = Promise.resolve();
  const listeners = new Set<() => void>();
  const publish = (next: CustomizeState) => {
    state = next;
    for (const listener of [...listeners]) listener();
  };

  const stopEvents = host.onEvent(CUSTOMIZE_CHANGED_EVENT, (payload) => {
    if (payload && typeof payload === "object") publish(payload as CustomizeState);
  });
  void host.invoke(CUSTOMIZE_COMMANDS.get, {}).then((answer) => {
    loaded = true;
    publish(answer as CustomizeState);
  }, () => { loaded = true; publish(state); });

  return {
    getSnapshot: (): CustomizeState => state,
    isLoaded: (): boolean => loaded,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    /** Applies `edit` here at once and on the host; resolves with the host's error text, if any. */
    update(edit: CustomizeEdit): Promise<string | undefined> {
      const before = state;
      const next = edit(state);
      publish(next);
      const write = writing.then(() => host.invoke(CUSTOMIZE_COMMANDS.set, { state: next })).then(
        (answer) => { if (state === next) publish(answer as CustomizeState); return undefined; },
        (error: unknown) => { if (state === next) publish(before); return errorMessage(error); },
      );
      writing = write;
      return write;
    },
    dispose(): void {
      stopEvents();
      listeners.clear();
    },
  };
}

export type CustomizeStore = ReturnType<typeof createCustomizeStore>;
