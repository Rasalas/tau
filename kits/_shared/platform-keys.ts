/**
 * How a hint spells the command modifier on the client's platform, as core's
 * key chords do: ⌘ on macOS and iOS, Ctrl elsewhere.
 */
export function isMacClient(platform = typeof navigator === "undefined" ? "" : navigator.platform): boolean {
  return /mac|iphone|ipad/iu.test(platform);
}

/** ⌘ on macOS, Ctrl elsewhere. */
export function modKeyLabel(mac = isMacClient()): string {
  return mac ? "⌘" : "Ctrl";
}

/** The modifier and Enter: ⌘↵ on macOS, Ctrl+↵ elsewhere. */
export function modEnterLabel(mac = isMacClient()): string {
  return mac ? "⌘↵" : "Ctrl+↵";
}
