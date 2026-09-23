import type { UiClientDevice } from "../shared/connections.js";

/**
 * A rough name for the client behind a user agent, for a person to recognise
 * a row by. Nothing is decided on it: a user agent is whatever the client says.
 */
export function describeUserAgent(userAgent: string | undefined): UiClientDevice {
  const ua = userAgent ?? "";
  if (!ua) return { kind: "unknown" };
  const os = /iPhone|iPod/u.test(ua) ? "iOS"
    : /iPad/u.test(ua) ? "iPadOS"
      : /Android/u.test(ua) ? "Android"
        : /Mac OS X|Macintosh/u.test(ua) ? "macOS"
          : /Windows/u.test(ua) ? "Windows"
            : /CrOS/u.test(ua) ? "ChromeOS"
              : /Linux/u.test(ua) ? "Linux"
                : undefined;
  // Order matters: Edge and Electron also say Chrome, Chrome also says Safari.
  const browser = /Electron\//u.test(ua) ? "Tau window"
    : /Edg\//u.test(ua) ? "Edge"
      : /Firefox\/|FxiOS\//u.test(ua) ? "Firefox"
        : /Chrome\/|CriOS\//u.test(ua) ? "Chrome"
          : /Safari\//u.test(ua) ? "Safari"
            : /^node|undici/iu.test(ua) ? "Node"
              : undefined;
  const kind = /iPad|Tablet/u.test(ua) || (/Android/u.test(ua) && !/Mobile/u.test(ua)) ? "tablet"
    : /Mobile|iPhone|iPod/u.test(ua) ? "phone"
      : os ? "desktop" : "unknown";
  return { kind, ...(browser ? { browser } : {}), ...(os ? { os } : {}) };
}

/** `Chrome on macOS`, or whichever half is known. */
export function deviceLabel(device: UiClientDevice): string {
  if (device.browser && device.os) return `${device.browser} on ${device.os}`;
  return device.browser ?? device.os ?? "Unknown client";
}

/** An address as a person reads it: without the IPv4-mapped prefix. */
export function displayAddress(address: string | undefined): string | undefined {
  return address?.replace(/^::ffff:/u, "") || undefined;
}
