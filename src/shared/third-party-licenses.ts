/** One package Tau ships, with the notice its licence asks to be passed on. */
export interface ThirdPartyLicense {
  name: string;
  version: string;
  license: string;
  repository?: string;
  /** The package's LICENSE, COPYING or NOTICE file. */
  text?: string;
}

/**
 * `third-party-licenses.json` beside the page: many packages carry the same
 * notice word for word, so each text is stored once and packages point at it.
 */
export interface ThirdPartyLicenseManifest {
  texts: string[];
  packages: Array<Omit<ThirdPartyLicense, "text"> & { text?: number }>;
}

export const LICENSES_FILE = "third-party-licenses.json";

export function packLicenses(licenses: readonly ThirdPartyLicense[]): ThirdPartyLicenseManifest {
  const texts: string[] = [];
  const index = new Map<string, number>();
  const packages = licenses.map(({ text, ...rest }) => {
    if (text === undefined) return rest;
    let at = index.get(text);
    if (at === undefined) {
      at = texts.push(text) - 1;
      index.set(text, at);
    }
    return { ...rest, text: at };
  });
  return { texts, packages };
}

/** Reads the manifest back into one entry per package; anything malformed is left out. */
export function unpackLicenses(value: unknown): ThirdPartyLicense[] {
  const manifest = value as Partial<ThirdPartyLicenseManifest> | null;
  if (!manifest || !Array.isArray(manifest.packages)) return [];
  const texts = Array.isArray(manifest.texts) ? manifest.texts : [];
  return manifest.packages.flatMap((entry) => {
    if (!entry || typeof entry.name !== "string" || typeof entry.version !== "string") return [];
    const text = typeof entry.text === "number" && typeof texts[entry.text] === "string" ? texts[entry.text] : undefined;
    return [{
      name: entry.name,
      version: entry.version,
      license: typeof entry.license === "string" ? entry.license : "UNKNOWN",
      ...(typeof entry.repository === "string" && /^https?:\/\//u.test(entry.repository) ? { repository: entry.repository } : {}),
      ...(text ? { text } : {}),
    }];
  });
}
