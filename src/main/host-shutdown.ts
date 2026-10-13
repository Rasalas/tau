/** Dispose threads before releasing the process resources they may still use. */
export function createHostShutdown(
  dispose: () => Promise<unknown>,
  finish: (code: number) => Promise<void>,
): (code?: number) => Promise<void> {
  let pending: Promise<void> | undefined;
  return (code = 0) => {
    // Set the promise before teardown can request shutdown again.
    pending ??= Promise.resolve().then(async () => {
      await dispose();
      await finish(code);
    });
    return pending;
  };
}
