import type { CookieJar } from "./cookie-import.js";
import type { CookieToWrite } from "./cookie-read.js";

type Send = <T = Record<string, unknown>>(method: string, params?: object) => Promise<T>;
interface StoredCookie {
  name: string; value: string; domain: string; path: string;
  secure: boolean; httpOnly: boolean; sameSite?: string;
  session: boolean; expires: number; partitionKey?: unknown;
}

const sameSites = { unspecified: undefined, no_restriction: "None", lax: "Lax", strict: "Strict" } as const;

/** Uses the owned browser's root connection, never a page or client session. */
export function headlessCookieJar(send: Send, closeNormally: () => Promise<void>): CookieJar {
  return {
    async set(cookie: CookieToWrite) {
      const sameSite = sameSites[cookie.sameSite];
      const { expirationDate, sameSite: _sameSite, ...fields } = cookie;
      await send("Storage.setCookies", { cookies: [{ ...fields,
        ...(sameSite ? { sameSite } : {}),
        ...(expirationDate !== undefined ? { expires: expirationDate } : {}),
      }] });
      // Chromium may acknowledge the command while its cookie store refuses a
      // particular cookie. Count only the canonical value read back from it.
      const { cookies } = await send<{ cookies: StoredCookie[] }>("Storage.getCookies");
      const host = new URL(cookie.url).hostname;
      const domain = cookie.domain ?? host;
      const accepted = cookies.some((stored) =>
        stored.name === cookie.name && stored.value === cookie.value &&
        (stored.domain === domain || (cookie.domain !== undefined && stored.domain === host && domain === `.${host}`)) &&
        stored.path === cookie.path && stored.secure === cookie.secure && stored.httpOnly === cookie.httpOnly &&
        stored.sameSite === sameSite && stored.partitionKey === undefined &&
        (expirationDate === undefined ? stored.session : !stored.session && stored.expires > 0 && stored.expires <= expirationDate + 1));
      if (!accepted) throw new Error("Chromium refused the imported cookie.");
    },
    // CDP has no cookie flush command. Completion requires normal process exit.
    flushStore: closeNormally,
  };
}
