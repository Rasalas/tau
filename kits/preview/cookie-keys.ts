import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CookieImportError } from "./cookie-read.js";

/** Hands out a Chromium browser's cookie secret, which on macOS lives in the keychain. */
export interface CookieKeyProvider {
  secret(keychain: { service: string; account: string }): Promise<string>;
}

/** `security`'s exit status for an item that does not exist (errSecItemNotFound). */
const ITEM_NOT_FOUND = 44;
/** The user has a modal in front of them; a timer racing it would drop an approval. */
const KEYCHAIN_TIMEOUT_MS = 5 * 60_000;

/**
 * Reads the secret with `/usr/bin/security`. macOS asks the user first and
 * names `security` in the prompt; "Allow" answers once, while "Always Allow"
 * would let any program read the item through the same tool. Never runs
 * under test: the keychain is the user's.
 */
export const keychainKeyProvider: CookieKeyProvider = {
  secret({ service, account }) {
    if (process.env.VITEST) return Promise.reject(new Error("The keychain is never read under test."));
    return new Promise((resolve, reject) => {
      execFile("/usr/bin/security", ["find-generic-password", "-w", "-s", service, "-a", account], { timeout: KEYCHAIN_TIMEOUT_MS, windowsHide: true }, (error, stdout) => {
        const secret = typeof stdout === "string" ? stdout.replace(/\n$/u, "") : "";
        if (!error && secret) return resolve(secret);
        const code = (error as { code?: unknown } | null)?.code;
        reject(code === ITEM_NOT_FOUND || (!error && !secret)
          ? new CookieImportError("keychain-missing", `The keychain has no "${service}" item. Open the browser once, then try again.`)
          : code === "ENOENT"
            ? new CookieImportError("keychain-unavailable", "This Mac has no /usr/bin/security to ask the keychain with.")
            : new CookieImportError("keychain-denied", `The keychain did not hand out "${service}". Choose Allow when macOS asks, then try again.`));
      });
    });
  },
};

/**
 * A stand-in keychain for an isolated instance: `keychain.json` under the
 * fixture root maps a service to its secret. The real keychain is never asked.
 */
export function fixtureKeyProvider(root: string): CookieKeyProvider {
  return {
    async secret({ service }) {
      const items = await readFile(join(root, "keychain.json"), "utf8").then((text) => JSON.parse(text) as Record<string, unknown>, () => ({} as Record<string, unknown>));
      const secret = items[service];
      if (typeof secret !== "string" || !secret) throw new CookieImportError("keychain-missing", `The fixture keychain has no "${service}" item.`);
      return secret;
    },
  };
}
