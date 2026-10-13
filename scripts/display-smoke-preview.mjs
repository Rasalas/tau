const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Window halves can announce themselves before the browser window is created. */
export async function openDisplayPreview(preview, url, { timeoutMs = 60_000, log = console.log, windowState = () => "" } = {}) {
  const started = Date.now();
  const deadline = started + timeoutMs;
  let lastMessage;
  while (true) {
    try {
      const opened = await preview("open", { url });
      if (lastMessage) log(`  (preview ready after ${Date.now() - started} ms; ${windowState()})`);
      return opened;
    } catch (error) {
      if (!(error instanceof Error) || !/Preview is unavailable because no Tau desktop window/u.test(error.message)) throw error;
      if (error.message !== lastMessage) log(`  (waiting for a drawable window; ${windowState()}; ${error.message})`);
      lastMessage = error.message;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for a drawable preview window after ${timeoutMs} ms; ${windowState()}; ${lastMessage}`, { cause: error });
      await wait(Math.min(100, remaining));
    }
  }
}
