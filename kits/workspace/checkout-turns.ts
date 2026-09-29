import type { HostExtensionServices, HostTurnObserver } from "tau/host-extension";

export interface CheckoutTurn {
  sessionId: string;
  title: string;
}

/**
 * The threads with a turn running in one checkout, which a branch switch
 * there would change the files under. Threads are known from their turns
 * and tools; the asking client names its own, which may have run neither yet.
 */
export function createCheckoutTurns(services: Pick<HostExtensionServices, "thread">, checkoutKey: (cwd: string) => Promise<string>) {
  const seen = new Set<string>();
  const observer: HostTurnObserver = {
    accepted: (sessionId) => { seen.add(sessionId); },
    toolEnded: (sessionId) => { seen.add(sessionId); },
  };
  const running = async (cwd: string, asking?: string): Promise<CheckoutTurn[]> => {
    const key = await checkoutKey(cwd);
    const turns: CheckoutTurn[] = [];
    for (const sessionId of new Set([...seen, ...(asking ? [asking] : [])])) {
      const thread = services.thread(sessionId);
      if (!thread || thread.sessionId !== sessionId) { seen.delete(sessionId); continue; }
      if (!thread.isStreaming() || await checkoutKey(thread.cwd).catch(() => undefined) !== key) continue;
      turns.push({ sessionId, title: thread.sessionName() || "A thread" });
    }
    return turns;
  };
  return { observer, running };
}
