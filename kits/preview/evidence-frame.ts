/**
 * The Preview's side of evidence capture: one frame of the page on request,
 * never while a secret has the keyboard. Evidence Kit calls it through the
 * `evidence-frame` host command, granted to it by id.
 */

/** Evidence Kit, the one caller of `evidence-frame`. */
export const EVIDENCE_CALLER = "tau.evidence";

export type PreviewEvidenceFrame =
  | { data: string; width: number; height: number; url: string; title: string; visible: boolean }
  | { skipped: "closed" | "secret" | "empty" };

/**
 * Runs in the page's isolated world: true while focus is in a password or
 * one-time-code field, or in a frame this world cannot look into.
 */
export function previewSecretFocus(): boolean {
  let element: Element | null = document.activeElement;
  for (let depth = 0; element && depth < 16; depth += 1) {
    if (element instanceof HTMLIFrameElement || element instanceof HTMLFrameElement) {
      let inner: Document | null = null;
      try {
        inner = element.contentDocument;
      } catch {
        inner = null;
      }
      if (!inner) return true;
      element = inner.activeElement;
      continue;
    }
    const shadow = (element as HTMLElement).shadowRoot?.activeElement;
    if (shadow) {
      element = shadow;
      continue;
    }
    if (element instanceof HTMLInputElement) {
      const type = element.type.toLowerCase();
      const autocomplete = (element.getAttribute("autocomplete") ?? "").toLowerCase();
      return type === "password" || /\b(?:one-time-code|current-password|new-password)\b/u.test(autocomplete);
    }
    return false;
  }
  return false;
}
