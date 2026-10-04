/** A connected window process is not proof that it still owns a drawable window. */
export const PREVIEW_WINDOW_UNAVAILABLE = "Preview is unavailable because no Tau desktop window on the thread's home machine can draw it. Open the Tau desktop app on the thread's home machine, then retry. You can watch the host-rendered page in Preview from your phone or browser once that window is open.";

/** Includes older window halves, which can stay connected after their Mac window closes. */
export function previewWindowUnavailable(error: unknown): boolean {
  return error instanceof Error && (
    error.message === PREVIEW_WINDOW_UNAVAILABLE ||
    /No Tau window on this host has the window half|This window cannot draw a preview\./u.test(error.message)
  );
}
