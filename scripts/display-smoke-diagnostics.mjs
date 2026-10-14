/** Failure probes have their own budget and never supply a frame to the smoke. */
export async function logDisplayDiagnostics(preview, capturePage, { log = console.log, timeoutMs = 5_000 } = {}) {
  let timer;
  try {
    const facts = await Promise.race([
      preview("smoke-diagnostics", { capturePage }),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ status: "diagnostic-request-timeout" }), timeoutMs); }),
    ]);
    log(`[display-smoke-diagnostics] ${JSON.stringify(facts)}`);
  } catch {
    log("[display-smoke-diagnostics] diagnostic request failed");
  } finally {
    clearTimeout(timer);
  }
}

/** State sampling runs alongside retries; the final capture probe runs only after failure. */
export function createDisplayFrameReader(preview, waitFor, { log = console.log } = {}) {
  let lastError;
  return async () => {
    let shot = null;
    let diagnostics;
    try {
      await waitFor(async () => {
        shot = await preview("mini-frame").catch((error) => {
          if (error.message !== lastError) log(`  (no frame yet: ${error.message})`);
          lastError = error.message;
          diagnostics ??= logDisplayDiagnostics(preview, false, { log });
          return null;
        });
        return shot?.data;
      }, "a frame of the page", 30_000);
    } catch (error) {
      await diagnostics;
      await logDisplayDiagnostics(preview, true, { log });
      throw error;
    }
    return shot;
  };
}
